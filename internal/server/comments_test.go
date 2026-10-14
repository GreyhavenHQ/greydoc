package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

type threadView struct {
	ID       string `json:"id"`
	Quote    string `json:"quote"`
	QuoteNow string `json:"quote_now"`
	Detached bool   `json:"detached"`
	Status   string `json:"status"`
	Start    int    `json:"start"`
	Comments []struct {
		Body       string `json:"body"`
		AuthorName string `json:"author_name"`
	} `json:"comments"`
	AnchorStart string `json:"anchor_start"`
	AnchorEnd   string `json:"anchor_end"`
}

func (e *testEnv) threads(alias string) []threadView {
	e.t.Helper()
	code, body := e.do(nil, "GET", "/api/notes/"+alias+"/comments", nil)
	if code != 200 {
		e.t.Fatalf("comments %d %s", code, body)
	}
	var r struct{ Threads []threadView }
	_ = json.Unmarshal([]byte(body), &r)
	return r.Threads
}

func TestCommentAnchorsFollowText(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "alpha beta gamma")
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	code, body := e.do(nil, "POST", "/api/notes/"+alias+"/comments", map[string]any{"quote": "beta", "body": "Is this right?"})
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	d := newYgoClient(t, e, alias)
	waitFor(t, "sync", func() bool { return ytext(d) == "alpha beta gamma" })

	// Concurrent insert before the anchor.
	yinsert(d, 0, "XXX ")
	waitFor(t, "live", func() bool { txt, _ := e.srv.LiveText(n.ID); return strings.HasPrefix(txt, "XXX") })
	th := e.threads(alias)
	if len(th) != 1 || th[0].QuoteNow != "beta" || th[0].Detached || th[0].Start != len("XXX alpha ") {
		t.Fatalf("after insert: %+v", th)
	}

	// Anchors sent by a browser are accepted as is.
	code, body = e.do(nil, "POST", "/api/notes/"+alias+"/comments", map[string]any{
		"anchor_start": th[0].AnchorStart, "anchor_end": th[0].AnchorEnd, "quote": "beta", "body": "second thread"})
	if code != 201 {
		t.Fatalf("relpos create: %d %s", code, body)
	}

	// Deleting the anchored text detaches the thread.
	_, err := e.srv.EditForTest(context.Background(), n.ID, "XXX alpha  gamma")
	if err != nil {
		t.Fatal(err)
	}
	th = e.threads(alias)
	if len(th) != 2 || !th[0].Detached || th[0].Quote != "beta" {
		t.Fatalf("after delete: %+v", th)
	}
}

func TestCommentLifecycle(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner", "name": "Olive"})
	viewer := e.login(idp, map[string]any{"sub": "v", "preferred_username": "viewer"})
	critic := e.login(idp, map[string]any{"sub": "c", "preferred_username": "critic", "name": "Cris"})
	alias := e.createNote(owner, "some text here")
	e.do(owner, "DELETE", "/api/notes/"+alias+"/permissions/groups/_signed_in", nil)
	e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/users/viewer", map[string]string{"level": "read"})
	e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/users/critic", map[string]string{"level": "comment"})

	if code, _ := e.do(viewer, "POST", "/api/notes/"+alias+"/comments", map[string]any{"quote": "text", "body": "x"}); code != 403 {
		t.Fatalf("read-only commented: %d", code)
	}
	code, body := e.do(critic, "POST", "/api/notes/"+alias+"/comments", map[string]any{"quote": "text", "body": "Vague"})
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	var created threadView
	_ = json.Unmarshal([]byte(body), &created)
	if code, body := e.do(owner, "POST", "/api/notes/"+alias+"/comments/"+created.ID+"/replies", map[string]any{"body": "Fixed"}); code != 201 {
		t.Fatalf("reply %d %s", code, body)
	}
	if code, _ := e.do(owner, "POST", "/api/notes/"+alias+"/comments/"+created.ID+"/resolve", nil); code != 200 {
		t.Fatal("resolve")
	}
	if code, _ := e.do(critic, "POST", "/api/notes/"+alias+"/comments/"+created.ID+"/reopen", nil); code != 200 {
		t.Fatal("reopen")
	}
	if code, _ := e.do(owner, "POST", "/api/notes/"+alias+"/comments/missing/resolve", nil); code != 404 {
		t.Fatal("missing thread")
	}
	code, body = e.do(viewer, "GET", "/api/notes/"+alias+"/comments", nil)
	if code != 200 || !strings.Contains(body, `"status":"open"`) || !strings.Contains(body, "Fixed") {
		t.Fatalf("viewer reads comments: %d %s", code, body)
	}
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	events, _ := e.srv.Store().Events(context.Background(), n.ID, 50)
	var kinds []string
	for _, ev := range events {
		if strings.HasPrefix(ev.Kind, "comment.") {
			kinds = append(kinds, ev.Kind+"/"+ev.ActorName)
		}
	}
	if strings.Join(kinds, ",") != "comment.reopen/Cris,comment.resolve/Olive,comment.reply/Olive,comment.create/Cris" {
		t.Fatalf("events %v", kinds)
	}
}

func TestCommentQuoteMustExist(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "abc")
	if code, _ := e.do(nil, "POST", "/api/notes/"+alias+"/comments", map[string]any{"quote": "zzz", "body": "x"}); code != 422 {
		t.Fatalf("missing quote: %d", code)
	}
	if code, _ := e.do(nil, "POST", "/api/notes/"+alias+"/comments", map[string]any{"quote": "abc", "body": ""}); code != 400 {
		t.Fatalf("empty body: %d", code)
	}
}
