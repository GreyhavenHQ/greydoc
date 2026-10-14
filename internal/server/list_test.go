package server_test

import (
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
	e.do(nil, "GET", "/api/notes/"+beta+"?visit=1", nil)
	_, body = e.do(nil, "GET", "/api/notes?scope=recent", nil)
	if !strings.Contains(body, "Beta") || strings.Contains(body, "Alpha") {
		t.Fatalf("recent: %s", body)
	}
}
