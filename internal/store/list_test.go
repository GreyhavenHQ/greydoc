package store

import (
	"slices"
	"testing"

	"github.com/greyhavenhq/greydoc/internal/permission"
)

func TestListNotesVisibility(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		alice, _ := st.UpsertOIDCUser(ctx, "a", "alice", "Alice", "", []string{"eng"})
		bob, _ := st.UpsertOIDCUser(ctx, "b", "bob", "Bob", "", []string{"sales"})
		own, _ := st.CreateNote(ctx, NewNote{OwnerID: alice.ID, Alias: "alice-own"})
		shared, _ := st.CreateNote(ctx, NewNote{OwnerID: bob.ID, Alias: "bob-shared"})
		_ = st.SetUserGrant(ctx, shared.ID, alice.ID, permission.Read, nil)
		grp, _ := st.CreateNote(ctx, NewNote{OwnerID: bob.ID, Alias: "eng-note", Groups: map[string]permission.Level{"eng": permission.Write}})
		pub, _ := st.CreateNote(ctx, NewNote{OwnerID: bob.ID, Alias: "public", Groups: map[string]permission.Level{GroupSignedIn: permission.Read}})
		_, _ = st.CreateNote(ctx, NewNote{OwnerID: bob.ID, Alias: "private"})
		_ = st.SaveNoteState(ctx, grp.ID, NoteState{Title: "Eng", Tags: []string{"design"}})
		_ = st.SaveNoteState(ctx, pub.ID, NoteState{Title: "Pub", Tags: []string{"design", "q4"}})

		viewer := Viewer{UserID: alice.ID}
		aliases := func(f ListFilter) []string {
			f.Viewer = viewer
			ns, err := st.ListNotes(ctx, f)
			if err != nil {
				t.Fatal(err)
			}
			var out []string
			for _, n := range ns {
				out = append(out, n.PrimaryAlias)
			}
			return out
		}
		if got := aliases(ListFilter{Scope: ScopeAll}); len(got) != 3 || contains(got, "private") || contains(got, "eng-note") {
			t.Fatalf("all: %v", got)
		}
		if got := aliases(ListFilter{Scope: ScopeMine}); len(got) != 1 || got[0] != own.PrimaryAlias {
			t.Fatalf("mine: %v", got)
		}
		if got := aliases(ListFilter{Scope: ScopeShared}); len(got) != 1 || got[0] != "bob-shared" {
			t.Fatalf("shared: %v", got)
		}
		if got := aliases(ListFilter{Scope: ScopeAll, Tag: "q4"}); len(got) != 1 || got[0] != "public" {
			t.Fatalf("tag: %v", got)
		}
		_ = st.RecordVisit(ctx, alice.ID, pub.ID)
		if got := aliases(ListFilter{Scope: ScopeRecent}); len(got) != 1 || got[0] != "public" {
			t.Fatalf("recent: %v", got)
		}
		tags, err := st.TagCounts(ctx, viewer)
		if err != nil || len(tags) != 2 || tags[0].Tag != "design" || tags[0].Count != 1 {
			t.Fatalf("tags %+v %v", tags, err)
		}
		local, _ := st.ListNotes(ctx, ListFilter{Scope: ScopeAll, Viewer: Viewer{Local: true}})
		if len(local) != 5 {
			t.Fatalf("local sees %d", len(local))
		}
	})
}

func TestListNotesPagesInIDOrder(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		var ids []string
		for i := 0; i < 12; i++ {
			n, _ := st.CreateNote(ctx, NewNote{})
			ids = append([]string{n.ID}, ids...)
		}
		page := func(f ListFilter) []string {
			f.Viewer, f.Scope = Viewer{Local: true}, ScopeAll
			ns, err := st.ListNotes(ctx, f)
			if err != nil {
				t.Fatal(err)
			}
			var out []string
			for _, n := range ns {
				out = append(out, n.ID)
			}
			return out
		}
		if got := page(ListFilter{IDs: ids, Limit: 5, Offset: 0}); !slices.Equal(got, ids[:5]) {
			t.Fatalf("first page %v, want %v", got, ids[:5])
		}
		if got := page(ListFilter{IDs: ids, Limit: 5, Offset: 10}); !slices.Equal(got, ids[10:]) {
			t.Fatalf("last page %v, want %v", got, ids[10:])
		}
		all := append(page(ListFilter{Limit: 7}), page(ListFilter{Limit: 7, Offset: 7})...)
		if len(all) != 12 || len(slices.Compact(slices.Sorted(slices.Values(all)))) != 12 {
			t.Fatalf("pages overlap or miss notes: %v", all)
		}
	})
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func TestMigrationDropsNamedGroupGrants(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{Groups: map[string]permission.Level{"eng": permission.Write, GroupSignedIn: permission.Read}})
		if _, err := st.db.Exec(st.q(`DELETE FROM schema_migration WHERE version = ?`), "007_drop_named_group_grants"); err != nil {
			t.Fatal(err)
		}
		if err := st.Init(ctx); err != nil {
			t.Fatal(err)
		}
		acl, err := st.NoteACL(ctx, n.ID)
		if err != nil || len(acl.Groups) != 1 || acl.Groups[0].Group != GroupSignedIn {
			t.Fatalf("groups after migration: %+v %v", acl, err)
		}
		evs, err := st.Events(ctx, n.ID, 10)
		if err != nil {
			t.Fatal(err)
		}
		var removed []Event
		for _, ev := range evs {
			if ev.Kind == "permission.group_removed" {
				removed = append(removed, ev)
			}
		}
		if len(removed) != 1 || removed[0].Data["group"] != "eng" || removed[0].Data["level"] != "write" {
			t.Fatalf("events: %+v", evs)
		}
	})
}

func TestListNotesOwnerID(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		alice, _ := st.UpsertOIDCUser(ctx, "a", "alice", "Alice", "", nil)
		owned, _ := st.CreateNote(ctx, NewNote{OwnerID: alice.ID})
		unowned, _ := st.CreateNote(ctx, NewNote{})
		ns, err := st.ListNotes(ctx, ListFilter{Scope: ScopeAll, Viewer: Viewer{Local: true}})
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]string{}
		for _, n := range ns {
			got[n.ID] = n.OwnerID
		}
		if got[owned.ID] != alice.ID || got[unowned.ID] != "" {
			t.Fatalf("owner ids %v", got)
		}
	})
}
