package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/greyhavenhq/greydoc/internal/config"
)

type duplicateView struct {
	ID       string `json:"id"`
	Alias    string `json:"alias"`
	Title    string `json:"title"`
	OwnerID  string `json:"owner_id"`
	FolderID string `json:"folder_id"`
	Level    string `json:"level"`
}

func (e *testEnv) duplicate(c *http.Client, alias string) (int, duplicateView) {
	e.t.Helper()
	code, body := e.do(c, "POST", "/api/notes/"+alias+"/duplicate", nil)
	var v duplicateView
	_ = json.Unmarshal([]byte(body), &v)
	return code, v
}

func (e *testEnv) content(c *http.Client, alias string) string {
	e.t.Helper()
	code, body := e.do(c, "GET", "/api/notes/"+alias+"/content", nil)
	if code != 200 {
		e.t.Fatalf("content %s: %d %s", alias, code, body)
	}
	return body
}

func TestDuplicateNote(t *testing.T) {
	e, idp := newOIDCEnv(t)
	alice := e.login(idp, map[string]any{"sub": "a", "preferred_username": "alice"})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	alias := e.createNote(alice, "# Plan\nbody")
	e.do(alice, "DELETE", "/api/notes/"+alias+"/permissions/groups/_signed_in", nil)
	e.do(alice, "PUT", "/api/notes/"+alias+"/permissions/users/bob", map[string]string{"level": "read"})

	code, v := e.duplicate(bob, alias)
	if code != 201 {
		t.Fatalf("duplicate: %d", code)
	}
	if v.Alias == alias || v.Title != "Copy of Plan" || v.Level != "full" {
		t.Fatalf("copy %+v", v)
	}
	if got := e.content(bob, v.Alias); got != "# Copy of Plan\nbody" {
		t.Fatalf("content %q", got)
	}
	src, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	cp, _ := e.srv.Store().NoteByAlias(context.Background(), v.Alias)
	if cp.OwnerID == src.OwnerID || cp.OwnerID == "" {
		t.Fatalf("owner %q, source owner %q", cp.OwnerID, src.OwnerID)
	}
	if code, _ := e.do(alice, "GET", "/api/notes/"+v.Alias, nil); code != 403 {
		t.Fatalf("the copy keeps the grants of the source: %d", code)
	}

	events, _ := e.srv.Store().Events(context.Background(), cp.ID, 20)
	var create map[string]any
	for _, ev := range events {
		if ev.Kind == "note.create" {
			create = ev.Data
			if ev.Source != "human" || ev.ActorID != cp.OwnerID {
				t.Fatalf("event %+v", ev)
			}
		}
	}
	if create["duplicated_from"] != alias || create["source_title"] != "Plan" {
		t.Fatalf("create event data %v", create)
	}
}

func TestDuplicateUsesLiveText(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "# Plan")
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	if _, err := e.srv.EditForTest(context.Background(), n.ID, "# Plan\nlive edit"); err != nil {
		t.Fatal(err)
	}
	code, v := e.duplicate(nil, alias)
	if code != 201 {
		t.Fatalf("duplicate: %d", code)
	}
	if got := e.content(nil, v.Alias); got != "# Copy of Plan\nlive edit" {
		t.Fatalf("content %q", got)
	}
}

func TestDuplicateKeepsTextWithoutTitle(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "just text")
	_, v := e.duplicate(nil, alias)
	if got := e.content(nil, v.Alias); got != "just text" {
		t.Fatalf("content %q", got)
	}
}

func TestDuplicateFolder(t *testing.T) {
	e, idp := newOIDCEnv(t)
	alice := e.login(idp, map[string]any{"sub": "a", "preferred_username": "alice"})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	carol := e.login(idp, map[string]any{"sub": "c", "preferred_username": "carol"})
	folder := e.createFolder(alice, "Project", "")
	alias := e.createNote(alice, "# Plan")
	e.move(alice, []string{alias}, nil, folder, false)
	e.do(alice, "PUT", "/api/folders/"+folder+"/permissions/users/bob", map[string]string{"level": "write"})
	e.do(alice, "PUT", "/api/folders/"+folder+"/permissions/users/carol", map[string]string{"level": "read"})

	if _, v := e.duplicate(alice, alias); v.FolderID != folder {
		t.Fatalf("owner copy folder %q", v.FolderID)
	}
	if _, v := e.duplicate(bob, alias); v.FolderID != folder {
		t.Fatalf("writer copy folder %q", v.FolderID)
	}
	code, v := e.duplicate(carol, alias)
	if code != 201 || v.FolderID != "" {
		t.Fatalf("reader copy: %d %+v", code, v)
	}
	if code, _ := e.do(alice, "GET", "/api/notes/"+v.Alias, nil); code != 403 {
		t.Fatalf("root copy is visible to the source owner: %d", code)
	}
}

var uploadLink = regexp.MustCompile(`/uploads/[0-9a-f]{32}\.png`)

func TestDuplicateCopiesUploads(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "# Plan")
	_, body := upload(t, e, nil, alias, "photo.png", pngBytes)
	var m struct{ URL string }
	_ = json.Unmarshal([]byte(body), &m)
	missing := "/uploads/" + strings.Repeat("a", 32) + ".png"
	other := "https://other.example" + m.URL
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	text := "# Plan\n![a](" + m.URL + ")\n![b](" + missing + ")\n![c](" + other + ")"
	if _, err := e.srv.EditForTest(context.Background(), n.ID, text); err != nil {
		t.Fatal(err)
	}

	code, v := e.duplicate(nil, alias)
	if code != 201 {
		t.Fatalf("duplicate: %d", code)
	}
	got := e.content(nil, v.Alias)
	links := uploadLink.FindAllString(got, -1)
	if len(links) != 3 || links[0] == m.URL || links[1] != missing || !strings.Contains(got, "("+other+")") {
		t.Fatalf("content %q", got)
	}
	media, _ := e.srv.Store().NoteMedia(context.Background(), v.ID)
	if len(media) != 1 || "/uploads/"+media[0].StoredName != links[0] || media[0].Filename != "photo.png" ||
		media[0].ContentType != "image/png" {
		t.Fatalf("media %+v", media)
	}

	e.do(nil, "DELETE", "/api/notes/"+alias, nil)
	if code, _ := e.do(nil, "DELETE", "/api/notes/"+alias+"?permanent=1", nil); code != 204 {
		t.Fatalf("purge: %d", code)
	}
	if _, err := os.Stat(filepath.Join(e.cfg.DataDir, "uploads", filepath.Base(m.URL))); !os.IsNotExist(err) {
		t.Fatalf("original file kept: %v", err)
	}
	if resp, body := e.get(links[0]); resp.StatusCode != 200 || body != string(pngBytes) {
		t.Fatalf("copy file after purge: %d", resp.StatusCode)
	}
}

func TestDuplicateErrors(t *testing.T) {
	e, idp := newOIDCEnv(t)
	alice := e.login(idp, map[string]any{"sub": "a", "preferred_username": "alice"})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	alias := e.createNote(alice, "# Plan")
	e.do(alice, "PUT", "/api/notes/"+alias+"/permissions/groups/_everyone", map[string]string{"level": "read"})

	if code, _ := e.duplicate(nil, alias); code != 401 {
		t.Fatalf("anonymous: %d", code)
	}
	e.do(alice, "DELETE", "/api/notes/"+alias+"/permissions/groups/_everyone", nil)
	e.do(alice, "DELETE", "/api/notes/"+alias+"/permissions/groups/_signed_in", nil)
	if code, _ := e.duplicate(bob, alias); code != 403 {
		t.Fatalf("no access: %d", code)
	}
	if code, _ := e.duplicate(alice, "nope"); code != 404 {
		t.Fatalf("missing: %d", code)
	}
	e.do(alice, "DELETE", "/api/notes/"+alias, nil)
	if code, _ := e.duplicate(alice, alias); code != 410 {
		t.Fatalf("trashed: %d", code)
	}
}

func TestDuplicateTooLong(t *testing.T) {
	e := newTestEnv(t, func(c *config.Config) { c.MaxNoteLength = 10 })
	alias := e.createNote(nil, "# 12345678")
	if code, _ := e.duplicate(nil, alias); code != 413 {
		t.Fatalf("too long: %d", code)
	}
}
