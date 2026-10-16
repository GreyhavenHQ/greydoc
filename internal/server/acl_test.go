package server_test

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNotePermissionsFlow(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner", "groups": []string{"eng"}})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob", "groups": []string{"sales"}})
	alias := e.createNote(owner, "# Plan")

	// Default: only the owner.
	if code, _ := e.do(bob, "GET", "/api/notes/"+alias, nil); code != 403 {
		t.Fatalf("signed-in default: %d", code)
	}
	if code, _ := e.do(nil, "GET", "/api/notes/"+alias, nil); code != 401 {
		t.Fatalf("guest: %d", code)
	}

	// Grant bob comment.
	if code, b := e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/users/bob", map[string]string{"level": "comment"}); code != 200 {
		t.Fatalf("%d %s", code, b)
	}
	code, body := e.do(bob, "GET", "/api/notes/"+alias, nil)
	if code != 200 || !strings.Contains(body, `"level":"comment"`) {
		t.Fatalf("bob comment: %d %s", code, body)
	}
	// Only the owner changes permissions.
	if code, _ := e.do(bob, "PUT", "/api/notes/"+alias+"/permissions/users/bob", map[string]string{"level": "write"}); code != 403 {
		t.Fatalf("bob escalated: %d", code)
	}
	// Group grant.
	if code, _ := e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/groups/sales", map[string]string{"level": "write"}); code != 200 {
		t.Fatal("group grant")
	}
	if _, body := e.do(bob, "GET", "/api/notes/"+alias, nil); !strings.Contains(body, `"level":"write"`) {
		t.Fatalf("group grant not applied: %s", body)
	}
	// Full is not grantable.
	if code, _ := e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/users/bob", map[string]string{"level": "full"}); code != 400 {
		t.Fatalf("full grant: %d", code)
	}
	// Only the owner sees who else has access.
	_, body = e.do(owner, "GET", "/api/notes/"+alias+"/permissions", nil)
	if !strings.Contains(body, `"username":"bob"`) || !strings.Contains(body, `"group":"sales"`) {
		t.Fatalf("owner view: %s", body)
	}
	_, body = e.do(bob, "GET", "/api/notes/"+alias+"/permissions", nil)
	if strings.Contains(body, `"username":"bob"`) || strings.Contains(body, `"sales"`) || !strings.Contains(body, `"agent_policy"`) {
		t.Fatalf("non-owner view leaks grants: %s", body)
	}
}

func TestShareLinkGrantsReadOnly(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner"})
	alias := e.createNote(owner, "client report")
	code, body := e.do(owner, "POST", "/api/notes/"+alias+"/share-links", map[string]string{"label": "client"})
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	var created struct {
		Link struct{ ID, Token string } `json:"link"`
		URL  string                     `json:"url"`
	}
	_ = json.Unmarshal([]byte(body), &created)
	if !strings.HasSuffix(created.URL, "/v/"+created.Link.Token) || len(created.Link.Token) != 16 {
		t.Fatalf("url %q", created.URL)
	}
	code, body = e.do(nil, "GET", "/api/share/"+created.Link.Token, nil)
	if code != 200 || !strings.Contains(body, `"alias":"`+alias+`"`) {
		t.Fatalf("token lookup: %d %s", code, body)
	}
	if code, _ := e.do(nil, "GET", "/api/share/wrong", nil); code != 404 {
		t.Fatalf("bad token lookup: %d", code)
	}
	code, body = e.do(nil, "GET", "/api/notes/"+alias+"?share="+created.Link.Token, nil)
	if code != 200 || !strings.Contains(body, `"level":"read"`) || !strings.Contains(body, "client report") {
		t.Fatalf("share read: %d %s", code, body)
	}
	if code, _ := e.do(nil, "GET", "/api/notes/"+alias+"?share=wrong", nil); code != 401 {
		t.Fatalf("bad token: %d", code)
	}
	if code, _ := e.do(owner, "DELETE", "/api/notes/"+alias+"/share-links/"+created.Link.ID, nil); code != 200 {
		t.Fatal("revoke")
	}
	if code, _ := e.do(nil, "GET", "/api/notes/"+alias+"?share="+created.Link.Token, nil); code != 401 {
		t.Fatalf("revoked token still works: %d", code)
	}
	if code, _ := e.do(nil, "GET", "/api/share/"+created.Link.Token, nil); code != 404 {
		t.Fatalf("revoked token still resolves: %d", code)
	}
}

func TestPermissionChangesWriteEvents(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner", "name": "Olive"})
	e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	alias := e.createNote(owner, "x")
	e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/users/bob", map[string]string{"level": "read"})
	e.do(owner, "PUT", "/api/notes/"+alias+"/agent-policy", map[string]string{"policy": "edit"})
	n, _ := e.srv.Store().NoteByAlias(t.Context(), alias)
	events, err := e.srv.Store().Events(t.Context(), n.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	kinds := []string{}
	for _, ev := range events {
		kinds = append(kinds, ev.Kind)
		if ev.ActorName != "Olive" {
			t.Fatalf("actor %q", ev.ActorName)
		}
	}
	if strings.Join(kinds, ",") != "agent_policy,permission.user,note.create" {
		t.Fatalf("events %v", kinds)
	}
}

func TestCrossOriginMutationRefused(t *testing.T) {
	e := newTestEnv(t)
	code, _ := e.do(nil, "POST", "/api/notes", map[string]string{"content": "x"}, "Origin", "https://evil.example")
	if code != 403 {
		t.Fatalf("cross-origin create: %d", code)
	}
	code, _ = e.do(nil, "POST", "/api/notes", map[string]string{"content": "x"}, "Origin", e.ts.URL)
	if code != 201 {
		t.Fatalf("same-origin create: %d", code)
	}
}
