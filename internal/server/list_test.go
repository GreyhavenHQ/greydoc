package server_test

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestListNotesAndTags(t *testing.T) {
	e := newTestEnv(t)
	e.createNote(nil, "---\ntags: [design]\n---\n# Alpha")
	beta := e.createNote(nil, "# Beta\nfind the needle here")
	code, body := e.do(nil, "GET", "/api/notes", nil)
	if code != 200 || !strings.Contains(body, `"title":"Alpha"`) || !strings.Contains(body, `"title":"Beta"`) {
		t.Fatalf("%d %s", code, body)
	}
	_, body = e.do(nil, "GET", "/api/notes?tag=design", nil)
	if strings.Contains(body, "Beta") || !strings.Contains(body, "Alpha") {
		t.Fatalf("tag filter: %s", body)
	}
	_, body = e.do(nil, "GET", "/api/notes?q=needle", nil)
	if !strings.Contains(body, "Beta") || strings.Contains(body, "Alpha") {
		t.Fatalf("search: %s", body)
	}
	_, body = e.do(nil, "GET", "/api/tags", nil)
	if !strings.Contains(body, `{"tag":"design","count":1}`) {
		t.Fatalf("tags: %s", body)
	}
	_, body = e.do(nil, "GET", "/api/notes?limit=1", nil)
	if strings.Count(body, `"alias"`) != 1 {
		t.Fatalf("limit: %s", body)
	}
	e.do(nil, "GET", "/api/notes/"+beta+"?visit=1", nil)
	_, body = e.do(nil, "GET", "/api/notes?scope=recent", nil)
	if !strings.Contains(body, "Beta") || strings.Contains(body, "Alpha") {
		t.Fatalf("recent: %s", body)
	}
}

func TestListNotesByTitleOrderedByVisit(t *testing.T) {
	e := newTestEnv(t)
	first := e.createNote(nil, "# Zebra first\n")
	second := e.createNote(nil, "# Zebra second\n")
	e.createNote(nil, "# Body\n\nzebra in the text\n")
	for _, a := range []string{first, second} {
		if code, body := e.do(nil, "GET", "/api/notes/"+a+"?visit=1", nil); code != 200 {
			t.Fatalf("visit %s: %d %s", a, code, body)
		}
	}
	code, body := e.do(nil, "GET", "/api/notes?scope=all&title=zebra&sort=visited", nil)
	if code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	var r struct {
		Notes []struct {
			Alias string `json:"alias"`
		} `json:"notes"`
	}
	_ = json.Unmarshal([]byte(body), &r)
	if len(r.Notes) != 2 || r.Notes[0].Alias != second || r.Notes[1].Alias != first {
		t.Fatalf("notes: %s", body)
	}
}
