package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

type suggestionView struct {
	ID       string `json:"id"`
	Status   string `json:"status"`
	Original string `json:"original"`
	Proposed string `json:"proposed"`
	Source   string `json:"source"`
	Stale    bool   `json:"stale"`
}

func TestSuggestionLifecycle(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner", "name": "Olive"})
	critic := e.login(idp, map[string]any{"sub": "c", "preferred_username": "critic", "name": "Cris"})
	viewer := e.login(idp, map[string]any{"sub": "v", "preferred_username": "viewer"})
	alias := e.createNote(owner, "The plan is bad.")
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	e.do(owner, "DELETE", "/api/notes/"+alias+"/permissions/groups/_signed_in", nil)
	e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/users/critic", map[string]string{"level": "comment"})
	e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/users/viewer", map[string]string{"level": "read"})

	if code, _ := e.do(viewer, "POST", "/api/notes/"+alias+"/suggestions", map[string]any{"quote": "bad", "proposed": "good"}); code != 403 {
		t.Fatalf("reader suggested: %d", code)
	}
	code, body := e.do(critic, "POST", "/api/notes/"+alias+"/suggestions", map[string]any{"quote": "bad", "proposed": "good", "reason": "tone"})
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	var sg suggestionView
	_ = json.Unmarshal([]byte(body), &sg)
	if sg.Original != "bad" || sg.Source != "human" || sg.Status != "pending" {
		t.Fatalf("%+v", sg)
	}
	text, _ := e.srv.TextForTest(context.Background(), n.ID)
	if text != "The plan is bad." {
		t.Fatalf("suggestion changed the text: %q", text)
	}
	if code, _ := e.do(critic, "POST", "/api/notes/"+alias+"/suggestions/"+sg.ID+"/accept", nil); code != 403 {
		t.Fatalf("commenter accepted: %d", code)
	}
	if code, body := e.do(owner, "POST", "/api/notes/"+alias+"/suggestions/"+sg.ID+"/accept", nil); code != 200 {
		t.Fatalf("accept %d %s", code, body)
	}
	text, _ = e.srv.TextForTest(context.Background(), n.ID)
	if text != "The plan is good." {
		t.Fatalf("after accept: %q", text)
	}
	clients, _ := e.srv.Store().NoteClients(context.Background(), n.ID)
	last := clients[len(clients)-1]
	if last.DisplayName != "Cris" || last.Source != "human" {
		t.Fatalf("accepted text attributed to %+v", last)
	}
	if code, _ := e.do(owner, "POST", "/api/notes/"+alias+"/suggestions/"+sg.ID+"/accept", nil); code != 409 {
		t.Fatalf("double accept: %d", code)
	}

	// Reject leaves the text alone.
	_, body = e.do(critic, "POST", "/api/notes/"+alias+"/suggestions", map[string]any{"quote": "plan", "proposed": "idea"})
	_ = json.Unmarshal([]byte(body), &sg)
	if code, _ := e.do(owner, "POST", "/api/notes/"+alias+"/suggestions/"+sg.ID+"/reject", nil); code != 200 {
		t.Fatal("reject")
	}
	text, _ = e.srv.TextForTest(context.Background(), n.ID)
	if text != "The plan is good." {
		t.Fatalf("after reject: %q", text)
	}

	events, _ := e.srv.Store().Events(context.Background(), n.ID, 50)
	var kinds []string
	for _, ev := range events {
		if strings.HasPrefix(ev.Kind, "suggestion.") {
			kinds = append(kinds, ev.Kind+"/"+ev.ActorName)
		}
	}
	if strings.Join(kinds, ",") != "suggestion.reject/Olive,suggestion.create/Cris,suggestion.accept/Olive,suggestion.create/Cris" {
		t.Fatalf("events %v", kinds)
	}
}

func TestStaleSuggestionNeedsReview(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "one two three")
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	_, body := e.do(nil, "POST", "/api/notes/"+alias+"/suggestions", map[string]any{"quote": "two three", "proposed": "2 3"})
	var sg suggestionView
	_ = json.Unmarshal([]byte(body), &sg)
	if _, err := e.srv.EditForTest(context.Background(), n.ID, "one TWO three"); err != nil {
		t.Fatal(err)
	}
	_, body = e.do(nil, "GET", "/api/notes/"+alias+"/suggestions", nil)
	if !strings.Contains(body, `"stale":true`) {
		t.Fatalf("not marked stale: %s", body)
	}
	code, body := e.do(nil, "POST", "/api/notes/"+alias+"/suggestions/"+sg.ID+"/accept", nil)
	if code != 409 || !strings.Contains(body, "stale") {
		t.Fatalf("stale accept: %d %s", code, body)
	}
	if code, _ := e.do(nil, "POST", "/api/notes/"+alias+"/suggestions/"+sg.ID+"/accept", map[string]any{"force": true}); code != 200 {
		t.Fatalf("forced accept: %d", code)
	}
	text, _ := e.srv.TextForTest(context.Background(), n.ID)
	if text != "one 2 3" {
		t.Fatalf("%q", text)
	}
}

func TestInsertionSuggestion(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "ab")
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	_, body := e.do(nil, "POST", "/api/notes/"+alias+"/suggestions", map[string]any{"quote": "ab", "proposed": "aXb"})
	var sg suggestionView
	_ = json.Unmarshal([]byte(body), &sg)
	if code, _ := e.do(nil, "POST", "/api/notes/"+alias+"/suggestions/"+sg.ID+"/accept", nil); code != 200 {
		t.Fatal("accept")
	}
	text, _ := e.srv.TextForTest(context.Background(), n.ID)
	if text != "aXb" {
		t.Fatalf("%q", text)
	}
}

func TestGetOneSuggestion(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "alpha beta")
	_, body := e.do(nil, "POST", "/api/notes/"+alias+"/suggestions", map[string]any{"quote": "beta", "proposed": "gamma", "reason": "why"})
	var sg suggestionView
	_ = json.Unmarshal([]byte(body), &sg)
	e.do(nil, "POST", "/api/notes/"+alias+"/suggestions/"+sg.ID+"/reject", nil)
	code, body := e.do(nil, "GET", "/api/notes/"+alias+"/suggestions/"+sg.ID, nil)
	if code != 200 || !strings.Contains(body, `"proposed":"gamma"`) || !strings.Contains(body, `"status":"rejected"`) || !strings.Contains(body, `"decided_by":"Local user"`) {
		t.Fatalf("%d %s", code, body)
	}
	if code, _ := e.do(nil, "GET", "/api/notes/"+alias+"/suggestions/missing", nil); code != 404 {
		t.Fatalf("missing: %d", code)
	}
}
