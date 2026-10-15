package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/greyhavenhq/greydoc/internal/config"
	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/server"
)

func TestHedgeDocModes(t *testing.T) {
	cases := map[string][2]permission.Level{
		"freely":    {permission.Write, permission.Write},
		"editable":  {permission.Read, permission.Write},
		"limited":   {permission.Deny, permission.Write},
		"locked":    {permission.Read, permission.Read},
		"protected": {permission.Deny, permission.Read},
		"private":   {permission.Deny, permission.Deny},
	}
	for mode, want := range cases {
		everyone, signedIn, ok := server.HedgeDocMode(mode)
		if !ok || everyone != want[0] || signedIn != want[1] {
			t.Errorf("%s: got %s/%s", mode, everyone, signedIn)
		}
	}
	if _, _, ok := server.HedgeDocMode("public"); ok {
		t.Fatal("unknown mode accepted")
	}
}

func TestImportThroughMCP(t *testing.T) {
	e, idp := newOIDCEnv(t, func(c *config.Config) { c.RoomIdleGrace = 20 * time.Millisecond })
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner"})
	e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	carol := e.login(idp, map[string]any{"sub": "c", "preferred_username": "carol"})
	_, body := e.do(owner, "POST", "/api/tokens", map[string]string{"label": "importer"})
	var tok struct{ Token string }
	_ = json.Unmarshal([]byte(body), &tok)
	s := e.mcp(tok.Token)

	out, isErr := call(t, s, "create_note", map[string]any{
		"content":       "# Imported\nfrom hedgedoc",
		"alias":         "s3BkeGgqTH-gU5UXqMZdag",
		"extra_aliases": []string{"SyJdkz5Jx"},
		"created_at":    "2021-03-04T10:00:00Z",
		"permissions":   map[string]any{"hedgedoc_mode": "protected", "users": map[string]string{"bob": "write"}},
		"agent_policy":  "read",
	})
	if isErr {
		t.Fatalf("create: %s", out)
	}
	code, body := e.do(owner, "GET", "/api/notes/s3BkeGgqTH-gU5UXqMZdag", nil)
	if code != 200 || !strings.Contains(body, `"created_at":"2021-03-04T10:00:00.000000Z"`) ||
		!strings.Contains(body, `"updated_at":"2021-03-04T10:00:00.000000Z"`) || !strings.Contains(body, `"agent_policy":"read"`) {
		t.Fatalf("%d %s", code, body)
	}
	if code, _ := e.do(owner, "GET", "/api/notes/SyJdkz5Jx", nil); code != 200 {
		t.Fatalf("short id: %d", code)
	}
	_, perms := e.do(owner, "GET", "/api/notes/s3bkeggqth-gu5uxqmzdag/permissions", nil)
	for _, want := range []string{`{"group":"_signed_in","level":"read"}`, `"username":"bob"`, `"level":"write"`} {
		if !strings.Contains(perms, want) {
			t.Fatalf("missing %s in %s", want, perms)
		}
	}
	if strings.Contains(perms, "_everyone") {
		t.Fatalf("protected note open to guests: %s", perms)
	}
	if code, body := e.do(carol, "GET", "/api/notes/SyJdkz5Jx", nil); code != 200 || !strings.Contains(body, `"level":"read"`) {
		t.Fatalf("signed-in read: %d %s", code, body)
	}

	// Opening and closing the note does not move its dates.
	n, _ := e.srv.Store().NoteByAlias(context.Background(), "SyJdkz5Jx")
	if _, err := e.srv.TextForTest(context.Background(), n.ID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	n, _ = e.srv.Store().NoteByID(context.Background(), n.ID)
	if n.UpdatedAt != "2021-03-04T10:00:00.000000Z" {
		t.Fatalf("updated_at moved to %s", n.UpdatedAt)
	}
}

func TestImportValidation(t *testing.T) {
	e := newTestEnv(t)
	for _, req := range []map[string]any{
		{"content": "x", "created_at": "yesterday"},
		{"content": "x", "created_at": "2022-01-01T00:00:00Z", "updated_at": "2021-01-01T00:00:00Z"},
		{"content": "x", "permissions": map[string]any{"hedgedoc_mode": "public"}},
		{"content": "x", "permissions": map[string]any{"users": map[string]string{"nobody": "read"}}},
		{"content": "x", "permissions": map[string]any{"signed_in": "full"}},
		{"content": "x", "agent_policy": "maybe"},
	} {
		if code, body := e.do(nil, "POST", "/api/notes", req); code != 400 && code != 404 {
			t.Errorf("%v: %d %s", req, code, body)
		}
	}
	if code, body := e.do(nil, "POST", "/api/notes", map[string]any{"content": "x", "alias": "kept-id", "created_at": "2020-05-06T07:08:09Z"}); code != 201 ||
		!strings.Contains(body, `"created_at":"2020-05-06T07:08:09.000000Z"`) {
		t.Fatalf("rest import: %d %s", code, body)
	}
}

func TestAgentPolicyDependsOnCreator(t *testing.T) {
	e := newTestEnv(t)
	human := e.createNote(nil, "by a person")
	out, isErr := call(t, e.mcp(""), "create_note", map[string]any{"content": "by an agent", "alias": "agent-made"})
	if isErr {
		t.Fatal(out)
	}
	_, explicit := call(t, e.mcp(""), "create_note", map[string]any{"content": "x", "alias": "agent-asked", "agent_policy": "suggest"})
	_ = explicit
	for alias, want := range map[string]string{human: "suggest", "agent-made": "edit", "agent-asked": "suggest"} {
		if _, body := e.do(nil, "GET", "/api/notes/"+alias, nil); !strings.Contains(body, `"agent_policy":"`+want+`"`) {
			t.Errorf("%s: want %s in %s", alias, want, body)
		}
	}
}

func TestViewCounter(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "# Counted")
	e.do(nil, "GET", "/api/notes/"+alias+"?visit=1", nil)
	e.do(nil, "GET", "/api/notes/"+alias+"?visit=1", nil)
	e.do(nil, "GET", "/api/notes/"+alias, nil)
	call(t, e.mcp(""), "read_note", map[string]any{"note": alias})
	_, body := e.do(nil, "GET", "/api/notes/"+alias, nil)
	if !strings.Contains(body, `"view_count":2`) {
		t.Fatalf("note: %s", body)
	}
	_, body = e.do(nil, "GET", "/api/notes?scope=all", nil)
	if !strings.Contains(body, `"view_count":2`) || !strings.Contains(body, `"owner":"Local user"`) {
		t.Fatalf("list: %s", body)
	}
	_, body = e.get("/" + alias + "/info")
	if !strings.Contains(body, `"viewcount":2`) {
		t.Fatalf("info: %s", body)
	}
}
