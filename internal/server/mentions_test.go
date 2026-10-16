package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

type notificationView struct {
	ID        string `json:"id"`
	NoteAlias string `json:"note_alias"`
	Kind      string `json:"kind"`
	ActorName string `json:"actor_name"`
	Ref       string `json:"ref"`
	Excerpt   string `json:"excerpt"`
	ReadAt    string `json:"read_at"`
}

func (e *testEnv) notifications(c *http.Client) ([]notificationView, int) {
	e.t.Helper()
	code, body := e.do(c, "GET", "/api/notifications", nil)
	if code != 200 {
		e.t.Fatalf("notifications %d %s", code, body)
	}
	var r struct {
		Notifications []notificationView `json:"notifications"`
		Unread        int                `json:"unread"`
	}
	_ = json.Unmarshal([]byte(body), &r)
	return r.Notifications, r.Unread
}

type mentionEnv struct {
	*testEnv
	alice, bob, carol *http.Client
	alias             string
}

// newMentionEnv has Bob own a private note that Alice can comment on and Carol cannot read.
func newMentionEnv(t *testing.T, content string) *mentionEnv {
	e, idp := newOIDCEnv(t)
	m := &mentionEnv{testEnv: e}
	m.alice = e.login(idp, map[string]any{"sub": "a", "preferred_username": "alice", "name": "Alice Martin"})
	m.carol = e.login(idp, map[string]any{"sub": "c", "preferred_username": "carol", "name": "Carol"})
	m.bob = e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob", "name": "Bob"})
	m.alias = e.createNote(m.bob, content)
	e.do(m.bob, "DELETE", "/api/notes/"+m.alias+"/permissions/groups/_signed_in", nil)
	e.do(m.bob, "PUT", "/api/notes/"+m.alias+"/permissions/users/alice", map[string]string{"level": "write"})
	return m
}

func TestCommentMentionsNotify(t *testing.T) {
	m := newMentionEnv(t, "some text here")
	code, body := m.do(m.bob, "POST", "/api/notes/"+m.alias+"/comments", map[string]any{"quote": "text",
		"body": "[@Alice](@alice) [@Carol](@carol) [@Bob](@bob) [@X](@nobody) can you check?"})
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	var th struct{ ID string }
	_ = json.Unmarshal([]byte(body), &th)
	list, unread := m.notifications(m.alice)
	if unread != 1 || len(list) != 1 {
		t.Fatalf("alice %d %+v", unread, list)
	}
	n := list[0]
	if n.Kind != "comment" || n.Ref != th.ID || n.ActorName != "Bob" || n.NoteAlias != m.alias || !strings.HasPrefix(n.Excerpt, "@Alice @Carol") {
		t.Fatalf("%+v", n)
	}
	if _, unread := m.notifications(m.carol); unread != 0 {
		t.Fatalf("carol cannot read but got %d", unread)
	}
	if _, unread := m.notifications(m.bob); unread != 0 {
		t.Fatalf("bob mentioned himself and got %d", unread)
	}
	m.do(m.bob, "POST", "/api/notes/"+m.alias+"/comments/"+th.ID+"/replies", map[string]any{"body": "ping [@Alice](@alice)"})
	list, unread = m.notifications(m.alice)
	if unread != 2 || list[0].Ref != th.ID {
		t.Fatalf("after reply %d %+v", unread, list)
	}
	if code, _ := m.do(m.alice, "POST", "/api/notifications/read", map[string]any{"ids": []string{list[0].ID}}); code != 204 {
		t.Fatalf("read one %d", code)
	}
	if _, unread := m.notifications(m.alice); unread != 1 {
		t.Fatalf("after read one %d", unread)
	}
	m.do(m.alice, "POST", "/api/notifications/read", map[string]any{"all": true})
	if _, unread := m.notifications(m.alice); unread != 0 {
		t.Fatalf("after read all %d", unread)
	}
	if code, _ := m.do(nil, "GET", "/api/notifications", nil); code != 401 {
		t.Fatalf("anonymous %d", code)
	}
}

func TestSuggestionMentionsNotifyOnce(t *testing.T) {
	m := newMentionEnv(t, "the plan is ready")
	m.do(m.bob, "PUT", "/api/notes/"+m.alias+"/permissions/users/carol", map[string]string{"level": "read"})
	code, body := m.do(m.alice, "POST", "/api/notes/"+m.alias+"/suggestions", map[string]any{"quote": "ready",
		"proposed": "ready for [@Carol](@carol)", "reason": "cc [@Bob](@bob) and [@Alice](@alice)"})
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	var sg struct{ ID string }
	_ = json.Unmarshal([]byte(body), &sg)
	for name, c := range map[string]*http.Client{"carol": m.carol, "bob": m.bob} {
		list, unread := m.notifications(c)
		if unread != 1 || list[0].Kind != "suggestion" || list[0].Ref != sg.ID || list[0].ActorName != "Alice Martin" {
			t.Fatalf("%s %d %+v", name, unread, list)
		}
	}
	if _, unread := m.notifications(m.alice); unread != 0 {
		t.Fatalf("alice mentioned herself and got %d", unread)
	}
	if code, body := m.do(m.bob, "POST", "/api/notes/"+m.alias+"/suggestions/"+sg.ID+"/accept", nil); code != 200 {
		t.Fatalf("accept %d %s", code, body)
	}
	if err := m.srv.ProcessHistory(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if _, unread := m.notifications(m.carol); unread != 1 {
		t.Fatalf("carol notified again after accept: %d", unread)
	}
}

func TestDocumentMentionsNotifyNewOnes(t *testing.T) {
	m := newMentionEnv(t, "hello")
	ctx := context.Background()
	n, _ := m.srv.Store().NoteByAlias(ctx, m.alias)
	edit := func(text string) {
		t.Helper()
		if _, err := m.srv.EditForTest(ctx, n.ID, text); err != nil {
			t.Fatal(err)
		}
		if err := m.srv.ProcessHistory(ctx, true); err != nil {
			t.Fatal(err)
		}
	}
	edit("hello [@Alice](@alice) and `[@Bob](@bob)`")
	list, unread := m.notifications(m.alice)
	if unread != 1 || list[0].Kind != "document" || list[0].Excerpt != "hello @Alice and `@Bob`" {
		t.Fatalf("first mention %d %+v", unread, list)
	}
	edit("hello [@Alice](@alice) again [@A](@alice) [@Carol](@carol)")
	if _, unread := m.notifications(m.alice); unread != 1 {
		t.Fatalf("existing mention notified again: %d", unread)
	}
	if _, unread := m.notifications(m.carol); unread != 0 {
		t.Fatalf("carol cannot read but got %d", unread)
	}
	edit("hello")
	edit("hello [@Alice](@alice)")
	if _, unread := m.notifications(m.alice); unread != 2 {
		t.Fatalf("mention added back: %d", unread)
	}
	m.do(m.bob, "DELETE", "/api/notes/"+m.alias, nil)
	if list, unread := m.notifications(m.alice); unread != 0 || len(list) != 0 {
		t.Fatalf("trashed note still listed: %d %+v", unread, list)
	}
}

func TestMCPCommentMentionsNotify(t *testing.T) {
	m := newMentionEnv(t, "Budget: 10k")
	_, body := m.do(m.bob, "POST", "/api/tokens", map[string]string{"label": "laptop"})
	var tok struct{ Token string }
	_ = json.Unmarshal([]byte(body), &tok)
	m.do(m.bob, "PUT", "/api/notes/"+m.alias+"/agent-policy", map[string]string{"policy": "suggest"})
	s := m.mcp(tok.Token)
	if out, isErr := call(t, s, "add_comment", map[string]any{"note": m.alias, "quote": "10k", "body": "[@Alice](@alice) source?"}); isErr {
		t.Fatal(out)
	}
	if list, unread := m.notifications(m.alice); unread != 1 || list[0].ActorName != "Bob" {
		t.Fatalf("%d %+v", unread, list)
	}
}

func TestUserSearchMarksReaders(t *testing.T) {
	m := newMentionEnv(t, "x")
	code, body := m.do(m.bob, "GET", "/api/users?q=&note="+m.alias, nil)
	if code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	var r struct {
		Users []struct {
			Username string `json:"username"`
			CanRead  *bool  `json:"can_read"`
		} `json:"users"`
	}
	_ = json.Unmarshal([]byte(body), &r)
	got := map[string]bool{}
	for _, u := range r.Users {
		if u.CanRead == nil {
			t.Fatalf("no can_read: %s", body)
		}
		got[u.Username] = *u.CanRead
	}
	if !got["alice"] || got["carol"] || !got["bob"] {
		t.Fatalf("%v", got)
	}
	if _, body := m.do(m.carol, "GET", "/api/users?q=&note="+m.alias, nil); strings.Contains(body, "can_read") {
		t.Fatalf("carol sees access of a note she cannot read: %s", body)
	}
}

func TestUserNames(t *testing.T) {
	m := newMentionEnv(t, "x")
	code, body := m.do(m.carol, "GET", "/api/users/names?u=alice&u=nobody", nil)
	if code != 200 || strings.TrimSpace(body) != `{"names":{"alice":"Alice Martin"}}` {
		t.Fatalf("%d %s", code, body)
	}
	if code, _ := m.do(nil, "GET", "/api/users/names?u=alice", nil); code != 401 {
		t.Fatalf("anonymous %d", code)
	}
}

func TestNotificationsAbsentInLocalMode(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "text")
	e.do(nil, "POST", "/api/notes/"+alias+"/comments", map[string]any{"quote": "text", "body": "[@Local user](@local)"})
	for _, path := range []string{"/api/notifications", "/api/users/names?u=local"} {
		if code, _ := e.do(nil, "GET", path, nil); code != 404 {
			t.Fatalf("%s %d", path, code)
		}
	}
	if code, _ := e.do(nil, "POST", "/api/notifications/read", map[string]any{"all": true}); code != 404 {
		t.Fatalf("read %d", code)
	}
}
