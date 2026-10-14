package history

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/greyhavenhq/greydoc/internal/collab"
	"github.com/greyhavenhq/greydoc/internal/store"
)

var ctx = context.Background()

// writer builds a Yjs update log for one note.
type writer struct {
	t     *testing.T
	st    *store.Store
	note  string
	state []byte
	at    time.Time
}

func newWriter(t *testing.T) *writer {
	st := store.OpenTest(t)
	n, err := st.CreateNote(ctx, store.NewNote{})
	if err != nil {
		t.Fatal(err)
	}
	return &writer{t: t, st: st, note: n.ID, at: time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)}
}

func (w *writer) edit(after time.Duration, user string, source store.Source, cid uint64, text string) {
	w.t.Helper()
	w.at = w.at.Add(after)
	up, err := collab.EditUpdate(w.state, cid, text)
	if err != nil {
		w.t.Fatal(err)
	}
	if up == nil {
		up, _ = collab.EditUpdate(w.state, cid, text+" ")
		w.state, _, _ = collab.Replay(w.state, [][]byte{up})
		up, _ = collab.EditUpdate(w.state, cid, text)
	}
	w.state, _, _ = collab.Replay(w.state, [][]byte{up})
	if err := w.st.AppendUpdates(ctx, w.note, []store.NoteUpdate{{UserID: user, Name: strings.ToUpper(user), Source: source,
		ClientID: cid, Data: up, CreatedAt: store.FormatTime(w.at)}}); err != nil {
		w.t.Fatal(err)
	}
}

func (w *writer) process(now time.Time, force bool) []store.Revision {
	w.t.Helper()
	p := &Processor{Store: w.st, Now: func() time.Time { return now }}
	if err := p.Process(ctx, w.note, force); err != nil {
		w.t.Fatal(err)
	}
	revs, err := w.st.Revisions(ctx, w.note, 100)
	if err != nil {
		w.t.Fatal(err)
	}
	return revs
}

func TestFirstRevision(t *testing.T) {
	w := newWriter(t)
	w.edit(0, "alice", store.SourceHuman, 1, "hello\n")
	revs := w.process(w.at.Add(time.Hour), false)
	if len(revs) != 1 {
		t.Fatalf("%d revisions", len(revs))
	}
	r, _ := w.st.Revision(ctx, w.note, revs[0].ID)
	if r.Text != "hello\n" || r.Added != 1 || r.Removed != 0 || !strings.Contains(r.Patch, "+hello") {
		t.Fatalf("%+v", r)
	}
	if len(r.Authors) != 1 || r.Authors[0].Name != "ALICE" {
		t.Fatalf("authors %+v", r.Authors)
	}
}

func TestCorrectDiff(t *testing.T) {
	w := newWriter(t)
	w.edit(0, "alice", store.SourceHuman, 1, "a\nb\nc\n")
	w.process(w.at.Add(time.Hour), false)
	w.edit(3*time.Hour, "alice", store.SourceHuman, 1, "a\nB\nc\nd\n")
	revs := w.process(w.at.Add(time.Hour), false)
	r, _ := w.st.Revision(ctx, w.note, revs[0].ID)
	if r.Added != 2 || r.Removed != 1 || !strings.Contains(r.Patch, "-b\n+B\n") || !strings.Contains(r.Patch, "+d\n") {
		t.Fatalf("patch:\n%s\n%+v", r.Patch, r)
	}
}

func TestNoRevisionWhenTextUnchanged(t *testing.T) {
	w := newWriter(t)
	w.edit(0, "alice", store.SourceHuman, 1, "same")
	w.process(w.at.Add(time.Hour), false)
	w.edit(3*time.Hour, "alice", store.SourceHuman, 1, "same!")
	w.edit(time.Second, "alice", store.SourceHuman, 1, "same")
	revs := w.process(w.at.Add(time.Hour), false)
	if len(revs) != 1 {
		t.Fatalf("%d revisions, want 1", len(revs))
	}
}

func TestSessionGrouping(t *testing.T) {
	w := newWriter(t)
	w.edit(0, "alice", store.SourceHuman, 1, "one")
	w.edit(30*time.Second, "bob", store.SourceHuman, 2, "one two")
	w.edit(30*time.Second, "alice", store.SourceHuman, 1, "one two three")
	// AI-assisted accept gets its own revision.
	w.edit(10*time.Second, "alice", store.SourceAIAssisted, 3, "One two three.")
	// Idle gap closes the session.
	w.edit(5*time.Minute, "alice", store.SourceHuman, 1, "One two three. Four")
	// A session longer than the cap is split.
	for i := 0; i < 20; i++ {
		w.edit(time.Minute, "alice", store.SourceHuman, 1, "One two three. Four"+strings.Repeat("!", i+1))
	}
	revs := w.process(w.at.Add(time.Hour), false)
	if len(revs) != 4 {
		for _, r := range revs {
			t.Logf("%s %v", r.StartedAt, r.Sources)
		}
		t.Fatalf("%d revisions, want 4", len(revs))
	}
	first := revs[len(revs)-1]
	if len(first.Authors) != 2 || first.Sources[0] != store.SourceHuman {
		t.Fatalf("first: %+v", first)
	}
	ai := revs[len(revs)-2]
	if len(ai.Sources) != 1 || ai.Sources[0] != store.SourceAIAssisted || ai.Authors[0].UserID != "alice" {
		t.Fatalf("ai: %+v", ai)
	}
}

func TestOpenSessionWaitsUnlessForced(t *testing.T) {
	w := newWriter(t)
	w.edit(0, "alice", store.SourceHuman, 1, "typing")
	if revs := w.process(w.at.Add(30*time.Second), false); len(revs) != 0 {
		t.Fatalf("open session committed: %d", len(revs))
	}
	if revs := w.process(w.at.Add(30*time.Second), true); len(revs) != 1 {
		t.Fatalf("forced: %d", len(revs))
	}
}

func TestCompactionKeepsReloadIdentical(t *testing.T) {
	w := newWriter(t)
	w.edit(0, "alice", store.SourceHuman, 1, "v1")
	w.edit(time.Second, "alice", store.SourceHuman, 1, "v2")
	if err := w.st.SaveSnapshot(ctx, w.note, w.state, store.NoteState{Content: "v2"}); err != nil {
		t.Fatal(err)
	}
	w.process(w.at.Add(time.Hour), false)
	left, _ := w.st.UpdatesBetween(ctx, w.note, 0, 0)
	if len(left) != 0 {
		t.Fatalf("%d updates left after compaction", len(left))
	}
	n, _ := w.st.NoteByID(ctx, w.note)
	_, text, err := collab.Replay(n.YState, nil)
	if err != nil || text != "v2" {
		t.Fatalf("reload %q %v", text, err)
	}
}
