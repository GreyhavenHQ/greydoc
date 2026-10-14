package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

type timelineView struct {
	Entries []struct {
		Kind     string `json:"kind"`
		Revision *struct {
			ID      int64    `json:"id"`
			Sources []string `json:"sources"`
			Authors []struct {
				Name   string `json:"name"`
				Source string `json:"source"`
			} `json:"authors"`
		} `json:"revision"`
		Event *struct {
			Kind string `json:"kind"`
		} `json:"event"`
	} `json:"entries"`
}

func (e *testEnv) timeline(alias string) timelineView {
	e.t.Helper()
	if err := e.srv.ProcessHistory(context.Background(), true); err != nil {
		e.t.Fatal(err)
	}
	code, body := e.do(nil, "GET", "/api/notes/"+alias+"/timeline", nil)
	if code != 200 {
		e.t.Fatalf("timeline %d %s", code, body)
	}
	var tl timelineView
	_ = json.Unmarshal([]byte(body), &tl)
	return tl
}

func TestTimelineAndRestore(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "# v1\n")
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	d := newYgoClient(t, e, alias)
	waitFor(t, "seed", func() bool { return ytext(d) == "# v1\n" })
	yinsert(d, 5, "more\n")
	waitFor(t, "live", func() bool { txt, _ := e.srv.LiveText(n.ID); return txt == "# v1\nmore\n" })

	tl := e.timeline(alias)
	var revs []int64
	kinds := []string{}
	for _, en := range tl.Entries {
		kinds = append(kinds, en.Kind)
		if en.Revision != nil {
			revs = append(revs, en.Revision.ID)
		}
	}
	if len(revs) != 1 || kinds[len(kinds)-1] != "event" {
		t.Fatalf("entries %v", kinds)
	}
	code, body := e.do(nil, "GET", "/api/notes/"+alias+"/revisions/"+itoa(revs[0]), nil)
	if code != 200 || !strings.Contains(body, `+more`) {
		t.Fatalf("revision %d %s", code, body)
	}

	yinsert(d, 0, "junk\n")
	waitFor(t, "junk", func() bool { txt, _ := e.srv.LiveText(n.ID); return strings.HasPrefix(txt, "junk") })
	e.timeline(alias)
	code, body = e.do(nil, "POST", "/api/notes/"+alias+"/revisions/"+itoa(revs[0])+"/restore", nil)
	if code != 200 {
		t.Fatalf("restore %d %s", code, body)
	}
	waitFor(t, "client sees restore", func() bool { return ytext(d) == "# v1\nmore\n" })
	tl = e.timeline(alias)
	var newest *struct {
		ID      int64    `json:"id"`
		Sources []string `json:"sources"`
		Authors []struct {
			Name   string `json:"name"`
			Source string `json:"source"`
		} `json:"authors"`
	}
	for _, en := range tl.Entries {
		if en.Revision != nil {
			newest = en.Revision
			break
		}
	}
	if newest == nil || newest.Sources[0] != "restore" {
		t.Fatalf("newest revision %+v", newest)
	}
	foundEvent := false
	for _, en := range tl.Entries {
		if en.Event != nil && en.Event.Kind == "revision.restore" {
			foundEvent = true
		}
	}
	if !foundEvent {
		t.Fatal("no restore event")
	}

	code, body = e.do(nil, "GET", "/api/notes/"+alias+"/clients", nil)
	if code != 200 || !strings.Contains(body, `"source":"restore"`) || !strings.Contains(body, `"source":"human"`) {
		t.Fatalf("clients %d %s", code, body)
	}
}

func itoa(i int64) string { b, _ := json.Marshal(i); return string(b) }
