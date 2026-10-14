package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"slices"
	"testing"

	"github.com/greyhavenhq/greydoc/internal/config"
)

type meView struct {
	Authenticated bool     `json:"authenticated"`
	LocalMode     bool     `json:"local_mode"`
	Username      string   `json:"username"`
	DisplayName   string   `json:"display_name"`
	Groups        []string `json:"groups"`
}

func TestLocalModeNeedsNoLogin(t *testing.T) {
	e := newTestEnv(t)
	resp, body := e.get("/api/me")
	var me meView
	_ = json.Unmarshal([]byte(body), &me)
	if resp.StatusCode != 200 || !me.Authenticated || !me.LocalMode || me.Username != "local" {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
}

func newOIDCEnv(t *testing.T) (*testEnv, *fakeIdP) {
	idp := newFakeIdP(t)
	e := newTestEnv(t, func(c *config.Config) {
		c.OIDCIssuer = idp.ts.URL
		c.OIDCClientID = "greydoc"
		c.OIDCClientSecret = "secret"
	})
	return e, idp
}

// login runs the browser flow and returns a client holding the session cookie.
func (e *testEnv) login(idp *fakeIdP, claims map[string]any) *http.Client {
	e.t.Helper()
	idp.setUser(claims)
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	resp, err := c.Get(e.ts.URL + "/auth/login?next=/n/abc")
	if err != nil {
		e.t.Fatal(err)
	}
	resp.Body.Close()
	if resp.Request.URL.Path != "/n/abc" {
		e.t.Fatalf("login ended at %s", resp.Request.URL)
	}
	return c
}

func TestOIDCLoginSetsSessionWithGroups(t *testing.T) {
	e, idp := newOIDCEnv(t)
	resp, body := e.get("/api/me")
	var me meView
	_ = json.Unmarshal([]byte(body), &me)
	if resp.StatusCode != 200 || me.Authenticated || me.LocalMode {
		t.Fatalf("anonymous: %d %s", resp.StatusCode, body)
	}

	c := e.login(idp, map[string]any{"sub": "u-1", "preferred_username": "alice", "name": "Alice A", "email": "a@x", "groups": []string{"eng", "ops"}})
	r, err := c.Get(e.ts.URL + "/api/me")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	me = meView{}
	_ = json.NewDecoder(r.Body).Decode(&me)
	if !me.Authenticated || me.Username != "alice" || me.DisplayName != "Alice A" || !slices.Equal(me.Groups, []string{"eng", "ops"}) {
		t.Fatalf("%+v", me)
	}

	// Groups are replaced on the next login.
	c = e.login(idp, map[string]any{"sub": "u-1", "preferred_username": "alice", "groups": []string{"eng"}})
	r2, _ := c.Get(e.ts.URL + "/api/me")
	defer r2.Body.Close()
	me = meView{}
	_ = json.NewDecoder(r2.Body).Decode(&me)
	if !slices.Equal(me.Groups, []string{"eng"}) {
		t.Fatalf("groups not refreshed: %+v", me)
	}
}

func TestLogoutDeletesSession(t *testing.T) {
	e, idp := newOIDCEnv(t)
	c := e.login(idp, map[string]any{"sub": "u-2", "preferred_username": "bob"})
	resp, err := c.Post(e.ts.URL+"/auth/logout", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	r, _ := c.Get(e.ts.URL + "/api/me")
	defer r.Body.Close()
	var me meView
	_ = json.NewDecoder(r.Body).Decode(&me)
	if me.Authenticated {
		t.Fatal("still authenticated after logout")
	}
}

func TestLoginRejectsForeignNext(t *testing.T) {
	e, idp := newOIDCEnv(t)
	idp.setUser(map[string]any{"sub": "u-3", "preferred_username": "carol"})
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	resp, err := c.Get(e.ts.URL + "/auth/login?next=//evil.example/x")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.Request.URL.Host != e.ts.Listener.Addr().String() || resp.Request.URL.Path != "/" {
		t.Fatalf("redirected to %s", resp.Request.URL)
	}
}
