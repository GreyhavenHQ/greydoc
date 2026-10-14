package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func TestTrashHidesAndRestores(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{Alias: "doomed"})
		_ = st.SaveNoteState(ctx, n.ID, NoteState{Title: "Doomed", Content: "findme words", Tags: []string{"gone"}})
		if err := st.TrashNote(ctx, n.ID, "alice", &Event{NoteID: n.ID, Kind: "note.trash"}); err != nil {
			t.Fatal(err)
		}
		got, err := st.NoteByAlias(ctx, "doomed")
		if err != nil || got.DeletedAt == "" || got.DeletedBy != "alice" {
			t.Fatalf("trashed note: %+v %v", got, err)
		}
		local := Viewer{Local: true}
		if ns, _ := st.ListNotes(ctx, ListFilter{Viewer: local, Scope: ScopeAll}); len(ns) != 0 {
			t.Fatalf("listed: %v", ns)
		}
		if ids, _ := st.SearchNoteIDs(ctx, "findme", 10); len(ids) != 0 {
			t.Fatalf("searchable: %v", ids)
		}
		if tags, _ := st.TagCounts(ctx, local); len(tags) != 0 {
			t.Fatalf("tags: %v", tags)
		}
		trash, err := st.Trash(ctx, local)
		if err != nil || len(trash) != 1 || trash[0].Title != "Doomed" {
			t.Fatalf("trash: %+v %v", trash, err)
		}
		if err := st.RestoreNote(ctx, n.ID, nil); err != nil {
			t.Fatal(err)
		}
		if ns, _ := st.ListNotes(ctx, ListFilter{Viewer: local, Scope: ScopeAll}); len(ns) != 1 {
			t.Fatalf("not restored: %v", ns)
		}
		if ids, _ := st.SearchNoteIDs(ctx, "findme", 10); len(ids) != 1 {
			t.Fatalf("not searchable after restore: %v", ids)
		}
	})
}

func TestTrashOnlyListsOwnNotes(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		a, _ := st.UpsertOIDCUser(ctx, "a", "alice", "", "", nil)
		b, _ := st.UpsertOIDCUser(ctx, "b", "bob", "", "", nil)
		na, _ := st.CreateNote(ctx, NewNote{OwnerID: a.ID})
		nb, _ := st.CreateNote(ctx, NewNote{OwnerID: b.ID})
		_ = st.TrashNote(ctx, na.ID, a.ID, nil)
		_ = st.TrashNote(ctx, nb.ID, b.ID, nil)
		if got, _ := st.Trash(ctx, Viewer{UserID: a.ID}); len(got) != 1 || got[0].ID != na.ID {
			t.Fatalf("alice trash %+v", got)
		}
		if got, _ := st.Trash(ctx, Viewer{UserID: a.ID, Admin: true}); len(got) != 2 {
			t.Fatalf("admin trash %+v", got)
		}
	})
}

func TestTrashedBefore(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		old, _ := st.CreateNote(ctx, NewNote{})
		fresh, _ := st.CreateNote(ctx, NewNote{})
		_ = st.TrashNote(ctx, old.ID, "", nil)
		_ = st.TrashNote(ctx, fresh.ID, "", nil)
		if _, err := st.db.ExecContext(ctx, st.q(`UPDATE note SET deleted_at = ? WHERE id = ?`),
			FormatTime(time.Now().Add(-40*24*time.Hour)), old.ID); err != nil {
			t.Fatal(err)
		}
		ids, err := st.TrashedBefore(ctx, time.Now().Add(-30*24*time.Hour))
		if err != nil || len(ids) != 1 || ids[0] != old.ID {
			t.Fatalf("%v %v", ids, err)
		}
	})
}

func TestMigrationAddsTrashColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE note (id TEXT PRIMARY KEY, owner_id TEXT, title TEXT NOT NULL DEFAULT '',
		description TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', ystate BLOB, ystate_upto BIGINT NOT NULL DEFAULT 0,
		history_state BLOB, history_upto BIGINT NOT NULL DEFAULT 0, agent_policy TEXT NOT NULL DEFAULT 'suggest',
		search_tags TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.Init(context.Background()); err != nil {
		t.Fatal(err)
	}
	n, err := st.CreateNote(ctx, NewNote{})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.TrashNote(ctx, n.ID, "x", nil); err != nil {
		t.Fatalf("trash on migrated db: %v", err)
	}
}
