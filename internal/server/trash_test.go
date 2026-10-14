package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/greyhavenhq/greydoc/internal/config"
)

func TestTrashLifecycle(t *testing.T) {
	e := newTestEnv(t, func(c *config.Config) { c.MirrorDebounce = 10 * time.Millisecond })
	alias := e.createNote(nil, "# Doomed\nbody")
	mirror := filepath.Join(e.cfg.DataDir, "notes", alias+".md")
	waitFor(t, "mirror", func() bool { _, err := os.Stat(mirror); return err == nil })

	if code, body := e.do(nil, "DELETE", "/api/notes/"+alias+"?permanent=1", nil); code != 409 {
		t.Fatalf("permanent delete outside trash: %d %s", code, body)
	}
	if code, _ := e.do(nil, "DELETE", "/api/notes/"+alias, nil); code != 204 {
		t.Fatalf("trash: %d", code)
	}
	code, body := e.do(nil, "GET", "/api/notes/"+alias, nil)
	if code != 410 || !strings.Contains(body, "in_trash") {
		t.Fatalf("trashed note: %d %s", code, body)
	}
	if resp, _ := e.get("/api/notes/" + alias); resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("a 410 must not be cached: %q", resp.Header.Get("Cache-Control"))
	}
	if _, body := e.do(nil, "GET", "/api/notes", nil); strings.Contains(body, alias) {
		t.Fatal("trashed note listed")
	}
	waitFor(t, "mirror removed", func() bool { _, err := os.Stat(mirror); return os.IsNotExist(err) })
	_, body = e.do(nil, "GET", "/api/trash", nil)
	if !strings.Contains(body, `"title":"Doomed"`) {
		t.Fatalf("trash list: %s", body)
	}
	if code, body := e.do(nil, "POST", "/api/notes/"+alias+"/restore", nil); code != 200 {
		t.Fatalf("restore: %d %s", code, body)
	}
	if code, _ := e.do(nil, "GET", "/api/notes/"+alias, nil); code != 200 {
		t.Fatalf("after restore: %d", code)
	}
	waitFor(t, "mirror back", func() bool { _, err := os.Stat(mirror); return err == nil })

	e.do(nil, "DELETE", "/api/notes/"+alias, nil)
	if code, _ := e.do(nil, "DELETE", "/api/notes/"+alias+"?permanent=1", nil); code != 204 {
		t.Fatalf("permanent: %d", code)
	}
	if code, _ := e.do(nil, "POST", "/api/notes/"+alias+"/restore", nil); code != 404 {
		t.Fatalf("restore after purge: %d", code)
	}
}

func TestTrashNeedsOwner(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner"})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	alias := e.createNote(owner, "x")
	if code, _ := e.do(bob, "DELETE", "/api/notes/"+alias, nil); code != 403 {
		t.Fatalf("writer trashed: %d", code)
	}
	e.do(owner, "DELETE", "/api/notes/"+alias, nil)
	if code, _ := e.do(bob, "POST", "/api/notes/"+alias+"/restore", nil); code != 403 {
		t.Fatalf("writer restored: %d", code)
	}
	if _, body := e.do(bob, "GET", "/api/trash", nil); strings.Contains(body, alias) {
		t.Fatal("bob sees owner's trash")
	}
}

func TestMCPTrash(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "x")
	s := e.mcp("")
	if out, isErr := call(t, s, "trash_note", map[string]any{"note": alias}); !isErr {
		t.Fatalf("trashed under suggest policy: %s", out)
	}
	e.do(nil, "PUT", "/api/notes/"+alias+"/agent-policy", map[string]string{"policy": "edit"})
	if out, isErr := call(t, s, "trash_note", map[string]any{"note": alias}); isErr {
		t.Fatalf("trash: %s", out)
	}
	if code, _ := e.do(nil, "GET", "/api/notes/"+alias, nil); code != 410 {
		t.Fatalf("not trashed: %d", code)
	}
	if out, isErr := call(t, s, "read_note", map[string]any{"note": alias}); !isErr || !strings.Contains(out, "trash") {
		t.Fatalf("read trashed: %s", out)
	}
	if out, isErr := call(t, s, "restore_note", map[string]any{"note": alias}); isErr {
		t.Fatalf("restore: %s", out)
	}
	if code, _ := e.do(nil, "GET", "/api/notes/"+alias, nil); code != 200 {
		t.Fatalf("not restored: %d", code)
	}
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	events, _ := e.srv.Store().Events(context.Background(), n.ID, 10)
	if events[0].Kind != "note.restore" || events[0].Source != "agent" || events[1].Kind != "note.trash" {
		t.Fatalf("events %+v", events[:2])
	}
}

func TestPurgeOldTrash(t *testing.T) {
	e := newTestEnv(t, func(c *config.Config) { c.TrashRetention = time.Millisecond })
	alias := e.createNote(nil, "x")
	e.do(nil, "DELETE", "/api/notes/"+alias, nil)
	time.Sleep(5 * time.Millisecond)
	if err := e.srv.PurgeTrash(context.Background()); err != nil {
		t.Fatal(err)
	}
	if code, _ := e.do(nil, "POST", "/api/notes/"+alias+"/restore", nil); code != 404 {
		t.Fatalf("purged note restorable: %d", code)
	}
	_, body := e.do(nil, "GET", "/api/audit?kind=note.delete", nil)
	if !strings.Contains(body, `"source":"system"`) {
		t.Fatalf("purge not audited: %s", body)
	}
}

type auditView struct {
	Events []struct {
		Kind      string `json:"kind"`
		ActorName string `json:"actor_name"`
		NoteTitle string `json:"note_title"`
		NoteState string `json:"note_state"`
	} `json:"events"`
}

func TestGlobalAudit(t *testing.T) {
	e, idp := newOIDCEnv(t, func(c *config.Config) { c.AdminGroup = "admins" })
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner", "name": "Olive"})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob", "name": "Bob"})
	admin := e.login(idp, map[string]any{"sub": "a", "preferred_username": "boss", "groups": []string{"admins"}})
	private := e.createNote(owner, "# Private plan")
	e.do(owner, "DELETE", "/api/notes/"+private+"/permissions/groups/_signed_in", nil)
	shared := e.createNote(owner, "# Shared plan")
	e.do(owner, "DELETE", "/api/notes/"+private, nil)
	e.do(bob, "POST", "/api/tokens", map[string]string{"label": "laptop"})

	read := func(c any, q string) auditView {
		t.Helper()
		code, body := e.do(c.(*http.Client), "GET", "/api/audit"+q, nil)
		if code != 200 {
			t.Fatalf("audit %d %s", code, body)
		}
		var v auditView
		_ = json.Unmarshal([]byte(body), &v)
		return v
	}
	all := read(admin, "")
	kinds := map[string]bool{}
	for _, ev := range all.Events {
		kinds[ev.Kind] = true
		if ev.Kind == "note.trash" && (ev.NoteTitle != "Private plan" || ev.NoteState != "trash") {
			t.Fatalf("trash event %+v", ev)
		}
	}
	for _, k := range []string{"note.create", "note.trash", "permission.group", "token.create", "user.login"} {
		if !kinds[k] {
			t.Fatalf("admin misses %s: %+v", k, all.Events)
		}
	}
	for _, ev := range read(bob, "").Events {
		if ev.NoteTitle == "Private plan" {
			t.Fatal("bob sees events of a note he cannot read")
		}
		if ev.Kind == "user.login" && ev.ActorName != "Bob" {
			t.Fatalf("bob sees someone else's login: %+v", ev)
		}
	}
	if v := read(admin, "?kind=note.trash"); len(v.Events) != 1 {
		t.Fatalf("kind filter: %+v", v.Events)
	}
	_ = shared
}
