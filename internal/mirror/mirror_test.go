package mirror

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/greyhavenhq/greydoc/internal/store"
)

func setup(t *testing.T) (*Mirror, *store.Store, string) {
	st := store.OpenTest(t)
	dir := t.TempDir()
	m := New(st, dir, 20*time.Millisecond)
	t.Cleanup(m.Close)
	return m, st, dir
}

func read(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(path); err == nil {
			return string(b)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s never written", path)
	return ""
}

func TestWritesFrontMatter(t *testing.T) {
	m, st, dir := setup(t)
	ctx := context.Background()
	u, _ := st.EnsureLocalUser(ctx)
	n, _ := st.CreateNote(ctx, store.NewNote{OwnerID: u.ID, Alias: "plan"})
	_ = st.SaveNoteState(ctx, n.ID, store.NoteState{Content: "# Plan\nbody\n", Title: "Plan", Tags: []string{"q4"}})
	m.Touch(n.ID)
	got := read(t, filepath.Join(dir, "notes", "plan.md"))
	for _, want := range []string{"---\ntitle: Plan\n", "tags:\n    - q4\n", "greydoc:\n", "id: " + n.ID, "owner: local", "---\n# Plan\nbody\n"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in\n%s", want, got)
		}
	}
}

func TestKeepsExistingFrontMatter(t *testing.T) {
	m, st, dir := setup(t)
	ctx := context.Background()
	n, _ := st.CreateNote(ctx, store.NewNote{Alias: "fm"})
	_ = st.SaveNoteState(ctx, n.ID, store.NoteState{Content: "---\ntags: [a, b]\ntype: slide\n---\n# Deck\n", Title: "Deck"})
	m.Touch(n.ID)
	got := read(t, filepath.Join(dir, "notes", "fm.md"))
	if !strings.HasPrefix(got, "---\ntags: [a, b]\ntype: slide\ngreydoc:\n") || !strings.HasSuffix(got, "---\n# Deck\n") {
		t.Fatalf("got\n%s", got)
	}
}

func TestRenameAndDelete(t *testing.T) {
	m, st, dir := setup(t)
	ctx := context.Background()
	n, _ := st.CreateNote(ctx, store.NewNote{Alias: "old-name"})
	m.Touch(n.ID)
	read(t, filepath.Join(dir, "notes", "old-name.md"))
	_ = st.AddAlias(ctx, n.ID, "new-name")
	_ = st.MakeAliasPrimary(ctx, n.ID, "new-name")
	m.Touch(n.ID)
	read(t, filepath.Join(dir, "notes", "new-name.md"))
	if _, err := os.Stat(filepath.Join(dir, "notes", "old-name.md")); !os.IsNotExist(err) {
		t.Fatal("old file kept after rename")
	}
	m.Remove(n.ID)
	time.Sleep(100 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(dir, "notes", "new-name.md")); !os.IsNotExist(err) {
		t.Fatal("file kept after delete")
	}
}

func TestRebuildOnStart(t *testing.T) {
	_, st, dir := setup(t)
	ctx := context.Background()
	n, _ := st.CreateNote(ctx, store.NewNote{Alias: "kept"})
	_ = st.SaveNoteState(ctx, n.ID, store.NoteState{Content: "x"})
	_ = os.MkdirAll(filepath.Join(dir, "notes"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "notes", "stale.md"), []byte("old"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "notes", "kept.md"), []byte("tampered"), 0o644)
	m := New(st, dir, time.Hour)
	defer m.Close()
	if err := m.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "notes", "stale.md")); !os.IsNotExist(err) {
		t.Fatal("stale file kept")
	}
	b, _ := os.ReadFile(filepath.Join(dir, "notes", "kept.md"))
	if !strings.HasSuffix(string(b), "---\nx") {
		t.Fatalf("not rewritten: %q", b)
	}
}
