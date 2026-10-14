package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
)

// fakeIdP is a minimal OIDC provider that logs in whoever is set as next user.
type fakeIdP struct {
	ts    *httptest.Server
	mu    sync.Mutex
	user  map[string]any
	codes map[string]map[string]any
}

func newFakeIdP(t *testing.T) *fakeIdP {
	idp := &fakeIdP{codes: map[string]map[string]any{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"issuer":                 idp.ts.URL,
			"authorization_endpoint": idp.ts.URL + "/authorize",
			"token_endpoint":         idp.ts.URL + "/token",
			"userinfo_endpoint":      idp.ts.URL + "/userinfo",
		})
	})
	mux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		idp.mu.Lock()
		code := "code-" + r.URL.Query().Get("state")
		idp.codes[code] = idp.user
		idp.mu.Unlock()
		u, _ := url.Parse(r.URL.Query().Get("redirect_uri"))
		q := u.Query()
		q.Set("code", code)
		q.Set("state", r.URL.Query().Get("state"))
		u.RawQuery = q.Encode()
		http.Redirect(w, r, u.String(), http.StatusFound)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "at-" + r.Form.Get("code"), "token_type": "Bearer"})
	})
	mux.HandleFunc("/userinfo", func(w http.ResponseWriter, r *http.Request) {
		code := r.Header.Get("Authorization")[len("Bearer at-"):]
		idp.mu.Lock()
		user := idp.codes[code]
		idp.mu.Unlock()
		if user == nil {
			http.Error(w, "bad token", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(user)
	})
	idp.ts = httptest.NewServer(mux)
	t.Cleanup(idp.ts.Close)
	return idp
}

func (idp *fakeIdP) setUser(claims map[string]any) {
	idp.mu.Lock()
	idp.user = claims
	idp.mu.Unlock()
}
