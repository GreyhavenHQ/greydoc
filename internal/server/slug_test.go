package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func noteIDFor(t *testing.T, e *testEnv, c *http.Client, alias string) string {
	t.Helper()
	_, body := e.do(c, "GET", "/api/notes/"+alias, nil)
	var n struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(body), &n)
	if n.ID == "" {
		t.Fatalf("no id in %s", body)
	}
	return n.ID
}

func TestSetSlug(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner"})
	writer := e.login(idp, map[string]any{"sub": "w", "preferred_username": "writer"})
	reader := e.login(idp, map[string]any{"sub": "r", "preferred_username": "reader"})
	alias := e.createNote(owner, "# Roadmap\n")
	e.do(owner, "DELETE", "/api/notes/"+alias+"/permissions/groups/_signed_in", nil)
	e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/users/writer", map[string]string{"level": "write"})
	e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/users/reader", map[string]string{"level": "read"})
	id := noteIDFor(t, e, owner, alias)

	code, body := e.do(owner, "PUT", "/api/notes/"+alias+"/slug", map[string]string{"slug": "Team-Roadmap"})
	if code != 200 || !strings.Contains(body, `"alias":"team-roadmap"`) || !strings.Contains(body, `"aliases"`) {
		t.Fatalf("set slug: %d %s", code, body)
	}
	if code, body := e.do(owner, "GET", "/api/notes/"+id, nil); code != 200 || !strings.Contains(body, `"alias":"team-roadmap"`) {
		t.Fatalf("by id: %d %s", code, body)
	}
	if code, b := e.do(owner, "PUT", "/api/notes/"+id+"/slug", map[string]string{"slug": "roadmap-2027"}); code != 200 {
		t.Fatalf("second slug: %d %s", code, b)
	}
	if code, _ := e.do(owner, "GET", "/api/notes/team-roadmap", nil); code != 404 {
		t.Fatalf("old slug: %d", code)
	}
	if code, _ := e.do(owner, "GET", "/api/notes/"+alias, nil); code != 200 {
		t.Fatalf("original alias: %d", code)
	}

	for name, c := range map[string]*http.Client{"writer": writer, "reader": reader} {
		if code, _ := e.do(c, "PUT", "/api/notes/"+id+"/slug", map[string]string{"slug": "mine"}); code != 403 {
			t.Fatalf("%s: %d", name, code)
		}
	}
	_, body = e.do(owner, "POST", "/api/tokens", map[string]string{"label": "ro", "scope": "notes:read"})
	var tok struct{ Token string }
	_ = json.Unmarshal([]byte(body), &tok)
	if code, b := e.do(nil, "PUT", "/api/notes/"+id+"/slug", map[string]string{"slug": "mine"}, "Authorization", "Bearer "+tok.Token); code != 403 {
		t.Fatalf("read-only token: %d %s", code, b)
	}

	if code, body := e.do(owner, "PUT", "/api/notes/"+id+"/slug", map[string]string{"slug": "api"}); code != 400 || !strings.Contains(body, "alias_forbidden") {
		t.Fatalf("reserved: %d %s", code, body)
	}
	other := e.createNote(owner, "other")
	if code, body := e.do(owner, "PUT", "/api/notes/"+id+"/slug", map[string]string{"slug": other}); code != 409 || !strings.Contains(body, "alias_taken") {
		t.Fatalf("taken: %d %s", code, body)
	}

	_, body = e.do(owner, "GET", "/api/audit?note="+id, nil)
	if !strings.Contains(body, `"alias.change"`) || !strings.Contains(body, `"previous":"team-roadmap"`) {
		t.Fatalf("audit: %s", body)
	}
}

func TestSetSlugKeepsLiveConnection(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "text")
	id := noteID(t, e, alias)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, e.wsURL()+"/"+id, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	got := make(chan string, 1)
	go func() {
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			if strings.Contains(string(data), `"type":"alias"`) {
				got <- string(data)
				return
			}
		}
	}()
	time.Sleep(100 * time.Millisecond)
	if code, b := e.do(nil, "PUT", "/api/notes/"+alias+"/slug", map[string]string{"slug": "renamed"}); code != 200 {
		t.Fatalf("%d %s", code, b)
	}
	select {
	case msg := <-got:
		if !strings.Contains(msg, `"type":"alias"`) || !strings.Contains(msg, `"alias":"renamed"`) {
			t.Fatalf("event %s", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no alias event")
	}
}
