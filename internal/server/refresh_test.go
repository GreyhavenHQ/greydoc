package server_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
)

// oauthTokens registers a client and signs a user in through the OAuth flow, as an MCP client does.
func oauthTokens(t *testing.T, e *testEnv, idp *fakeIdP) (clientID string, tok map[string]any) {
	t.Helper()
	_, body := e.do(nil, "POST", "/oauth/register", map[string]any{
		"client_name": "opencode", "redirect_uris": []string{"http://127.0.0.1:9999/cb"}, "token_endpoint_auth_method": "none"})
	var client struct {
		ClientID string `json:"client_id"`
	}
	_ = json.Unmarshal([]byte(body), &client)
	verifier, challenge := pkce()
	q := url.Values{"response_type": {"code"}, "client_id": {client.ClientID}, "redirect_uri": {"http://127.0.0.1:9999/cb"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}, "state": {"st"}, "scope": {"notes:read notes:write"}}
	user := e.login(idp, map[string]any{"sub": "u", "preferred_username": "user"})
	resp, err := user.Get(e.ts.URL + "/oauth/authorize?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	var page [64 << 10]byte
	n, _ := resp.Body.Read(page[:])
	resp.Body.Close()
	consent := between(string(page[:n]), `name="consent" value="`, `"`)
	user.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err = user.PostForm(e.ts.URL+"/oauth/authorize", url.Values{"consent": {consent}, "approve": {"1"}})
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	loc, _ := url.Parse(resp.Header.Get("Location"))
	code, tok := tokenRequest(t, e, url.Values{"grant_type": {"authorization_code"}, "code": {loc.Query().Get("code")},
		"client_id": {client.ClientID}, "redirect_uri": {"http://127.0.0.1:9999/cb"}, "code_verifier": {verifier}})
	if code != 200 {
		t.Fatalf("token: %d %v", code, tok)
	}
	return client.ClientID, tok
}

func tokenRequest(t *testing.T, e *testEnv, form url.Values) (int, map[string]any) {
	t.Helper()
	resp, err := http.PostForm(e.ts.URL+"/oauth/token", form)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

// Two sessions of the same MCP client share stored tokens. The second refreshes with the token the first
// already rotated. That must not sign both out.
func TestRefreshTokenSharedBySessions(t *testing.T) {
	e, idp := newOIDCEnv(t)
	clientID, tok := oauthTokens(t, e, idp)
	refresh := func(rt string) (int, map[string]any) {
		return tokenRequest(t, e, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {rt}, "client_id": {clientID}})
	}
	code, first := refresh(tok["refresh_token"].(string))
	if code != 200 {
		t.Fatalf("first session: %d %v", code, first)
	}
	code, second := refresh(tok["refresh_token"].(string))
	if code != 200 || second["access_token"] == first["access_token"] {
		t.Fatalf("second session with the rotated token: %d %v", code, second)
	}
	for name, set := range map[string]map[string]any{"first": first, "second": second} {
		if code, _ := e.do(nil, "GET", "/api/me", nil, "Authorization", "Bearer "+set["access_token"].(string)); code != 200 {
			t.Fatalf("%s session lost access: %d", name, code)
		}
		if code, res := refresh(set["refresh_token"].(string)); code != 200 {
			t.Fatalf("%s session cannot refresh again: %d %v", name, code, res)
		}
	}
}
