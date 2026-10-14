package server_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type bearer struct {
	token string
	base  http.RoundTripper
}

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if b.token != "" {
		r.Header.Set("Authorization", "Bearer "+b.token)
	}
	return b.base.RoundTrip(r)
}

func (e *testEnv) mcp(token string) *mcp.ClientSession {
	e.t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: "test-agent", Version: "1"}, nil)
	tr := &mcp.StreamableClientTransport{Endpoint: e.ts.URL + "/mcp", HTTPClient: &http.Client{Transport: bearer{token, http.DefaultTransport}}}
	sess, err := c.Connect(context.Background(), tr, nil)
	if err != nil {
		e.t.Fatalf("mcp connect: %v", err)
	}
	e.t.Cleanup(func() { sess.Close() })
	return sess
}

// call runs a tool and returns its text output and whether it reported an error.
func call(t *testing.T, s *mcp.ClientSession, name string, args map[string]any) (string, bool) {
	t.Helper()
	res, err := s.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	return b.String(), res.IsError
}

func TestMCPLocalModeNeedsNoToken(t *testing.T) {
	e := newTestEnv(t)
	s := e.mcp("")
	tools, err := s.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, tl := range tools.Tools {
		names[tl.Name] = true
	}
	for _, want := range []string{"list_notes", "search_notes", "read_note", "create_note", "list_comments", "add_comment",
		"reply_comment", "resolve_comment", "suggest_edit", "edit_note", "get_history", "trash_note", "restore_note"} {
		if !names[want] {
			t.Errorf("missing tool %s", want)
		}
	}
	out, isErr := call(t, s, "create_note", map[string]any{"content": "# Agent note\nhello", "alias": "agent-note"})
	if isErr || !strings.Contains(out, "agent-note") {
		t.Fatalf("create: %s", out)
	}
	out, _ = call(t, s, "read_note", map[string]any{"note": e.ts.URL + "/n/agent-note"})
	if !strings.Contains(out, "# Agent note") {
		t.Fatalf("read: %s", out)
	}
	out, _ = call(t, s, "search_notes", map[string]any{"query": "hello"})
	if !strings.Contains(out, "agent-note") {
		t.Fatalf("search: %s", out)
	}
}

func TestMCPAgentPolicy(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "The launch is in May.")
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	s := e.mcp("")

	// Default policy is suggest: edit_note becomes a suggestion.
	out, isErr := call(t, s, "edit_note", map[string]any{"note": alias, "old_text": "May", "new_text": "June"})
	if isErr || !strings.Contains(out, "suggestion") {
		t.Fatalf("edit under suggest: %s", out)
	}
	if text, _ := e.srv.TextForTest(context.Background(), n.ID); text != "The launch is in May." {
		t.Fatalf("text changed under suggest policy: %q", text)
	}
	_, body := e.do(nil, "GET", "/api/notes/"+alias+"/suggestions", nil)
	if !strings.Contains(body, `"source":"agent"`) || !strings.Contains(body, `"client":"test-agent"`) {
		t.Fatalf("suggestion %s", body)
	}

	e.do(nil, "PUT", "/api/notes/"+alias+"/agent-policy", map[string]string{"policy": "edit"})
	out, isErr = call(t, s, "edit_note", map[string]any{"note": alias, "old_text": "May", "new_text": "July"})
	if isErr {
		t.Fatalf("edit under edit policy: %s", out)
	}
	if text, _ := e.srv.TextForTest(context.Background(), n.ID); text != "The launch is in July." {
		t.Fatalf("after edit: %q", text)
	}
	clients, _ := e.srv.Store().NoteClients(context.Background(), n.ID)
	if last := clients[len(clients)-1]; last.Source != "agent" {
		t.Fatalf("agent edit attributed to %+v", last)
	}

	e.do(nil, "PUT", "/api/notes/"+alias+"/agent-policy", map[string]string{"policy": "read"})
	if out, isErr := call(t, s, "add_comment", map[string]any{"note": alias, "quote": "July", "body": "sure?"}); !isErr {
		t.Fatalf("comment under read policy: %s", out)
	}
	e.do(nil, "PUT", "/api/notes/"+alias+"/agent-policy", map[string]string{"policy": "none"})
	if out, isErr := call(t, s, "read_note", map[string]any{"note": alias}); !isErr {
		t.Fatalf("read under none policy: %s", out)
	}
}

func TestMCPComments(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "Budget: 10k")
	s := e.mcp("")
	out, isErr := call(t, s, "add_comment", map[string]any{"note": alias, "quote": "10k", "body": "Source?"})
	if isErr {
		t.Fatal(out)
	}
	var th struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(out), &th)
	if _, isErr := call(t, s, "reply_comment", map[string]any{"note": alias, "thread_id": th.ID, "body": "Finance sheet"}); isErr {
		t.Fatal("reply")
	}
	if _, isErr := call(t, s, "resolve_comment", map[string]any{"note": alias, "thread_id": th.ID}); isErr {
		t.Fatal("resolve")
	}
	out, _ = call(t, s, "list_comments", map[string]any{"note": alias, "include_resolved": true})
	if !strings.Contains(out, "Finance sheet") || !strings.Contains(out, `"status": "resolved"`) {
		t.Fatalf("list: %s", out)
	}
	if err := e.srv.ProcessHistory(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	out, _ = call(t, s, "get_history", map[string]any{"note": alias})
	if !strings.Contains(out, "comment.resolve") {
		t.Fatalf("history: %s", out)
	}
}

func TestMCPRequiresAuthInOIDCMode(t *testing.T) {
	e, _ := newOIDCEnv(t)
	resp, err := http.Post(e.ts.URL+"/mcp", "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	wa := resp.Header.Get("WWW-Authenticate")
	if resp.StatusCode != 401 || !strings.Contains(wa, `resource_metadata="`+e.ts.URL+`/.well-known/oauth-protected-resource/mcp"`) {
		t.Fatalf("%d %q", resp.StatusCode, wa)
	}
}

func TestPersonalTokenRespectsACL(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner"})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	alias := e.createNote(owner, "private plan")
	e.do(owner, "DELETE", "/api/notes/"+alias+"/permissions/groups/_signed_in", nil)
	code, body := e.do(bob, "POST", "/api/tokens", map[string]string{"label": "laptop"})
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	var tok struct{ Token string }
	_ = json.Unmarshal([]byte(body), &tok)
	s := e.mcp(tok.Token)
	if out, isErr := call(t, s, "read_note", map[string]any{"note": alias}); !isErr {
		t.Fatalf("bob read a private note: %s", out)
	}
	e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/users/bob", map[string]string{"level": "write"})
	if out, isErr := call(t, s, "read_note", map[string]any{"note": alias}); isErr {
		t.Fatalf("bob cannot read after grant: %s", out)
	}
	// The same token works on the REST API.
	if code, _ := e.do(nil, "GET", "/api/notes/"+alias, nil, "Authorization", "Bearer "+tok.Token); code != 200 {
		t.Fatalf("rest with token: %d", code)
	}
	if code, _ := e.do(nil, "GET", "/api/notes/"+alias, nil, "Authorization", "Bearer gd_pat_wrong"); code != 401 {
		t.Fatalf("bad token: %d", code)
	}
}

func pkce() (verifier, challenge string) {
	verifier = "verifier-" + strings.Repeat("x", 50)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

func TestOAuthFlow(t *testing.T) {
	e, idp := newOIDCEnv(t)

	_, body := e.get("/.well-known/oauth-protected-resource/mcp")
	if !strings.Contains(body, `"resource":"`+e.ts.URL+`/mcp"`) || !strings.Contains(body, `"authorization_servers":["`+e.ts.URL+`"]`) {
		t.Fatalf("resource metadata %s", body)
	}
	_, body = e.get("/.well-known/oauth-authorization-server")
	var meta map[string]any
	_ = json.Unmarshal([]byte(body), &meta)
	if meta["registration_endpoint"] != e.ts.URL+"/oauth/register" || !strings.Contains(body, `"S256"`) {
		t.Fatalf("as metadata %s", body)
	}

	code, body := e.do(nil, "POST", "/oauth/register", map[string]any{
		"client_name": "Claude", "redirect_uris": []string{"http://127.0.0.1:9999/cb"}, "token_endpoint_auth_method": "none"})
	if code != 201 {
		t.Fatalf("register %d %s", code, body)
	}
	var client struct {
		ClientID string `json:"client_id"`
	}
	_ = json.Unmarshal([]byte(body), &client)

	verifier, challenge := pkce()
	q := url.Values{"response_type": {"code"}, "client_id": {client.ClientID}, "redirect_uri": {"http://127.0.0.1:9999/cb"},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}, "state": {"st"}, "scope": {"notes:read notes:write"},
		"resource": {e.ts.URL + "/mcp"}}
	authorizeURL := e.ts.URL + "/oauth/authorize?" + q.Encode()

	// Not signed in: the authorize page sends the browser to the OIDC login first.
	noFollow := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := noFollow.Get(authorizeURL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if loc := resp.Header.Get("Location"); resp.StatusCode != 302 || !strings.HasPrefix(loc, "/auth/login?next=") {
		t.Fatalf("anonymous authorize: %d %s", resp.StatusCode, loc)
	}

	user := e.login(idp, map[string]any{"sub": "u", "preferred_username": "user", "name": "Uma"})
	resp, err = user.Get(authorizeURL)
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(page), "Claude") || !strings.Contains(string(page), `name="consent"`) {
		t.Fatalf("consent page: %s", page)
	}
	consent := between(string(page), `name="consent" value="`, `"`)
	user.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err = user.PostForm(e.ts.URL+"/oauth/authorize", url.Values{"consent": {consent}, "approve": {"1"}})
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	loc, _ := url.Parse(resp.Header.Get("Location"))
	if resp.StatusCode != 302 || loc.Query().Get("state") != "st" || loc.Query().Get("code") == "" {
		t.Fatalf("approve: %d %s", resp.StatusCode, loc)
	}
	authCode := loc.Query().Get("code")

	tokenReq := func(form url.Values) (int, map[string]any) {
		resp, err := http.PostForm(e.ts.URL+"/oauth/token", form)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var m map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&m)
		return resp.StatusCode, m
	}
	if code, _ := tokenReq(url.Values{"grant_type": {"authorization_code"}, "code": {authCode}, "client_id": {client.ClientID},
		"redirect_uri": {"http://127.0.0.1:9999/cb"}, "code_verifier": {"wrong"}}); code != 400 {
		t.Fatalf("wrong verifier accepted: %d", code)
	}
	// A failed exchange burns the code. Get a new one.
	resp, _ = user.PostForm(e.ts.URL+"/oauth/authorize", url.Values{"consent": {consent}, "approve": {"1"}})
	resp.Body.Close()
	loc, _ = url.Parse(resp.Header.Get("Location"))
	code, tok := tokenReq(url.Values{"grant_type": {"authorization_code"}, "code": {loc.Query().Get("code")}, "client_id": {client.ClientID},
		"redirect_uri": {"http://127.0.0.1:9999/cb"}, "code_verifier": {verifier}})
	if code != 200 || tok["access_token"] == nil || tok["refresh_token"] == nil || tok["token_type"] != "Bearer" {
		t.Fatalf("token: %d %v", code, tok)
	}

	s := e.mcp(tok["access_token"].(string))
	if out, isErr := call(t, s, "create_note", map[string]any{"content": "from claude"}); isErr {
		t.Fatalf("create with oauth token: %s", out)
	}

	code, tok2 := tokenReq(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)}, "client_id": {client.ClientID}})
	if code != 200 || tok2["access_token"] == tok["access_token"] {
		t.Fatalf("refresh: %d %v", code, tok2)
	}
	if code, _ := tokenReq(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)}, "client_id": {client.ClientID}}); code != 400 {
		t.Fatalf("refresh token reused: %d", code)
	}

	// The connected client shows in the user's token list and can be revoked there.
	_, body = e.do(user, "GET", "/api/tokens", nil)
	if !strings.Contains(body, "Claude") {
		t.Fatalf("tokens: %s", body)
	}
}

func between(s, a, b string) string {
	i := strings.Index(s, a)
	if i < 0 {
		return ""
	}
	s = s[i+len(a):]
	return s[:strings.Index(s, b)]
}

func TestMCPCallsAreAudited(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "# Audited note\nThe launch is in May.")
	s := e.mcp("")
	call(t, s, "read_note", map[string]any{"note": alias})
	call(t, s, "edit_note", map[string]any{"note": alias, "old_text": "not there", "new_text": "x"})
	long := strings.Repeat("word ", 200)
	call(t, s, "create_note", map[string]any{"content": long})
	call(t, s, "search_notes", map[string]any{"query": "launch"})

	_, body := e.do(nil, "GET", "/api/audit?kind=mcp", nil)
	var v struct {
		Events []struct {
			Kind      string         `json:"kind"`
			Client    string         `json:"client"`
			Source    string         `json:"source"`
			NoteTitle string         `json:"note_title"`
			Data      map[string]any `json:"data"`
		} `json:"events"`
	}
	_ = json.Unmarshal([]byte(body), &v)
	byTool := map[string]map[string]any{}
	session := false
	for _, ev := range v.Events {
		if ev.Kind == "mcp.session" && ev.Client == "test-agent" {
			session = true
		}
		if ev.Kind != "mcp.call" {
			continue
		}
		if ev.Client != "test-agent" || ev.Source != "agent" {
			t.Fatalf("event %+v", ev)
		}
		byTool[ev.Data["tool"].(string)] = ev.Data
		if ev.Data["tool"] == "read_note" && ev.NoteTitle != "Audited note" {
			t.Fatalf("read_note not tied to its note: %+v", ev)
		}
	}
	if !session {
		t.Fatalf("no session event: %s", body)
	}
	if byTool["read_note"]["ok"] != true || byTool["edit_note"]["ok"] != false || byTool["edit_note"]["error"] == "" {
		t.Fatalf("outcomes %+v", byTool)
	}
	args := byTool["create_note"]["args"].(map[string]any)
	if content := args["content"].(string); len(content) > 200 || !strings.Contains(content, "1000 characters") {
		t.Fatalf("long argument stored as %q", content)
	}
	if byTool["search_notes"]["args"].(map[string]any)["query"] != "launch" {
		t.Fatalf("search args %+v", byTool["search_notes"])
	}
	if _, ok := byTool["read_note"]["ms"]; !ok {
		t.Fatal("no duration")
	}
}

func TestMCPCallsStayOutOfNoteTimeline(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "x")
	call(t, e.mcp(""), "read_note", map[string]any{"note": alias})
	if _, body := e.do(nil, "GET", "/api/notes/"+alias+"/timeline", nil); strings.Contains(body, "mcp.call") {
		t.Fatalf("timeline lists MCP calls: %s", body)
	}
	if _, body := e.do(nil, "GET", "/api/audit?note="+alias, nil); !strings.Contains(body, "mcp.call") {
		t.Fatalf("audit misses the call: %s", body)
	}
}

func TestMCPUsageSummary(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "x")
	s := e.mcp("")
	call(t, s, "read_note", map[string]any{"note": alias})
	call(t, s, "read_note", map[string]any{"note": alias})
	call(t, s, "read_note", map[string]any{"note": "missing"})
	call(t, s, "list_notes", map[string]any{})
	code, body := e.do(nil, "GET", "/api/audit/mcp?days=7", nil)
	if code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	var v struct {
		Calls  int `json:"calls"`
		Errors int `json:"errors"`
		Tools  []struct {
			Name   string `json:"name"`
			Calls  int    `json:"calls"`
			Errors int    `json:"errors"`
		} `json:"tools"`
		Clients []struct {
			Name  string `json:"name"`
			Calls int    `json:"calls"`
		} `json:"clients"`
		People []struct {
			Name  string `json:"name"`
			Calls int    `json:"calls"`
		} `json:"people"`
	}
	_ = json.Unmarshal([]byte(body), &v)
	if v.Calls != 4 || v.Errors != 1 || v.Tools[0].Name != "read_note" || v.Tools[0].Calls != 3 || v.Tools[0].Errors != 1 {
		t.Fatalf("%+v", v)
	}
	if len(v.Clients) != 1 || v.Clients[0].Name != "test-agent" || v.People[0].Name != "Local user" {
		t.Fatalf("%+v", v)
	}
}
