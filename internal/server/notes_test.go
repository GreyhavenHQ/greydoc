package server_test

import (
	"strings"
	"testing"

	"github.com/greyhavenhq/greydoc/internal/config"
)

func TestCreateNoteMaxLength(t *testing.T) {
	e := newTestEnv(t, func(c *config.Config) { c.MaxNoteLength = 10 })
	code, body := e.do(nil, "POST", "/api/notes", map[string]string{"content": strings.Repeat("é", 11)})
	if code != 413 || !strings.Contains(body, "max_length") {
		t.Fatalf("%d %s", code, body)
	}
	if code, _ := e.do(nil, "POST", "/api/notes", map[string]string{"content": strings.Repeat("é", 10)}); code != 201 {
		t.Fatalf("at limit: %d", code)
	}
}

func TestCreateNoteFromMarkdownBody(t *testing.T) {
	e := newTestEnv(t)
	resp, err := e.ts.Client().Post(e.ts.URL+"/api/notes?alias=meeting", "text/markdown", strings.NewReader("---\ntags: [a]\n---\n# Meeting"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 201 {
		t.Fatalf("%d", resp.StatusCode)
	}
	code, body := e.do(nil, "GET", "/api/notes/meeting", nil)
	if code != 200 || !strings.Contains(body, `"title":"Meeting"`) || !strings.Contains(body, `"tags":["a"]`) {
		t.Fatalf("%d %s", code, body)
	}
	_, content := e.get("/api/notes/meeting/content")
	if !strings.HasSuffix(content, "# Meeting") {
		t.Fatalf("content %q", content)
	}
}

func TestDeleteNoteNeedsOwner(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner"})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	alias := e.createNote(owner, "x")
	if code, _ := e.do(bob, "DELETE", "/api/notes/"+alias, nil); code != 403 {
		t.Fatalf("writer deleted: %d", code)
	}
	if code, _ := e.do(owner, "DELETE", "/api/notes/"+alias, nil); code != 204 {
		t.Fatalf("owner delete: %d", code)
	}
	if code, _ := e.do(owner, "GET", "/api/notes/"+alias, nil); code != 410 {
		t.Fatalf("after delete, the note is in the trash: %d", code)
	}
}

func TestAliasManagement(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "x")
	if code, b := e.do(nil, "POST", "/api/notes/"+alias+"/aliases", map[string]any{"name": "Nice-Name", "primary": true}); code != 200 {
		t.Fatalf("%d %s", code, b)
	}
	_, body := e.do(nil, "GET", "/api/notes/nice-name", nil)
	if !strings.Contains(body, `"alias":"nice-name"`) {
		t.Fatalf("primary not switched: %s", body)
	}
	if code, _ := e.do(nil, "DELETE", "/api/notes/nice-name/aliases/nice-name", nil); code != 400 {
		t.Fatalf("removed primary: %d", code)
	}
	if code, _ := e.do(nil, "DELETE", "/api/notes/nice-name/aliases/"+alias, nil); code != 200 {
		t.Fatalf("remove secondary: %d", code)
	}
	if code, _ := e.do(nil, "POST", "/api/notes/nice-name/aliases", map[string]any{"name": "api"}); code != 400 {
		t.Fatalf("forbidden alias: %d", code)
	}
}
