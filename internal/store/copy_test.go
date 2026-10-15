package store

import (
	"os"
	"testing"

	"github.com/greyhavenhq/greydoc/internal/permission"
)

func TestCopySQLiteToPostgres(t *testing.T) {
	url := os.Getenv("GREYDOC_TEST_POSTGRES_URL")
	if url == "" {
		t.Skip("GREYDOC_TEST_POSTGRES_URL not set")
	}
	src := OpenTest(t)
	u, _ := src.UpsertOIDCUser(ctx, "s", "alice", "Alice", "a@x", []string{"eng"})
	n, _ := src.CreateNote(ctx, NewNote{OwnerID: u.ID, Alias: "plan", ExtraAliases: []string{"Old-ID"}, Groups: map[string]permission.Level{"eng": permission.Write}})
	_ = src.SaveSnapshot(ctx, n.ID, []byte{1, 2, 3}, NoteState{Content: "# Plan\nbody", Title: "Plan", Tags: []string{"q4"}})
	_ = src.AppendUpdates(ctx, n.ID, []NoteUpdate{{UserID: u.ID, Source: SourceHuman, ClientID: 1 << 52, Data: []byte{9}}})
	_ = src.AddEvent(ctx, &Event{NoteID: n.ID, ActorID: u.ID, ActorName: "Alice", Kind: "note.create"})
	_ = src.TrashNote(ctx, n.ID, "Alice", nil)
	_ = src.RestoreNote(ctx, n.ID, nil)

	dst := openPostgresTest(t, url)
	if _, err := dst.EnsureLocalUser(ctx); err != nil {
		t.Fatal(err)
	}
	if err := dst.CopyFrom(ctx, src); err != nil {
		t.Fatal(err)
	}
	got, err := dst.NoteByAlias(ctx, "old-id")
	if err != nil || got.Title != "Plan" || string(got.YState) != "\x01\x02\x03" || got.Tags[0] != "q4" || got.OwnerID != u.ID {
		t.Fatalf("%+v %v", got, err)
	}
	ups, _ := dst.UpdatesBetween(ctx, n.ID, 0, 0)
	if len(ups) != 1 || ups[0].ClientID != 1<<52 {
		t.Fatalf("updates %+v", ups)
	}
	// Sequences continue after the copied ids.
	if err := dst.AppendUpdates(ctx, n.ID, []NoteUpdate{{Source: SourceHuman, ClientID: 2, Data: []byte{1}}}); err != nil {
		t.Fatal(err)
	}
	if ids, _ := dst.SearchNoteIDs(ctx, "body", 5); len(ids) != 1 {
		t.Fatalf("search after copy: %v", ids)
	}
	if acl, _ := dst.NoteACL(ctx, n.ID); len(acl.Groups) != 1 {
		t.Fatalf("grants %+v", acl)
	}
	if err := dst.CopyFrom(ctx, src); err == nil {
		t.Fatal("copied twice into a database with notes")
	}
}
