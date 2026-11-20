package store

import (
	"fmt"
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
		if got := aliases(ListFilter{Scope: ScopeShared}); len(got) != 2 || !contains(got, "bob-shared") || !contains(got, "public") {
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

func TestListNotesPinnedFirst(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		alice, _ := st.UpsertOIDCUser(ctx, "a", "alice", "Alice", "", nil)
		bob, _ := st.UpsertOIDCUser(ctx, "b", "bob", "Bob", "", nil)
		folder, err := st.CreateFolder(ctx, NewFolder{OwnerID: alice.ID, Name: "F"})
		if err != nil {
			t.Fatal(err)
		}
		ids := map[string]string{}
		for _, n := range []struct{ alias, title, updated string }{
			{"zeta", "Zeta", "2024-01-01T00:00:00.000000Z"},
			{"alpha", "alpha", "2024-01-02T00:00:00.000000Z"},
			{"empty", "", "2024-01-03T00:00:00.000000Z"},
			{"mid", "Mid", "2024-01-04T00:00:00.000000Z"},
			{"plain", "Plain", "2024-01-05T00:00:00.000000Z"},
		} {
			note, err := st.CreateNote(ctx, NewNote{OwnerID: alice.ID, Alias: n.alias, UpdatedAt: n.updated, Users: map[string]permission.Level{bob.ID: permission.Read}})
			if err != nil {
				t.Fatal(err)
			}
			ids[n.alias] = note.ID
			if err := st.SaveNoteState(ctx, note.ID, NoteState{Title: n.title, Tags: []string{"t"}}); err != nil {
				t.Fatal(err)
			}
			if err := st.MoveNote(ctx, note.ID, folder.ID, nil); err != nil {
				t.Fatal(err)
			}
		}
		for i, a := range []string{"zeta", "alpha", "empty"} {
			if err := st.SetPinned(ctx, alice.ID, ids[a], true); err != nil {
				t.Fatal(err)
			}
			if _, err := st.db.Exec(st.q(`UPDATE note_visit SET visited_at = ? WHERE user_id = ? AND note_id = ?`), fmt.Sprintf("2024-02-0%dT00:00:00.000000Z", i+1), alice.ID, ids[a]); err != nil {
				t.Fatal(err)
			}
		}
		_ = st.RecordVisit(ctx, alice.ID, ids["mid"])
		aliases := func(v Viewer, f ListFilter) []string {
			f.Viewer = v
			ns, err := st.ListNotes(ctx, f)
			if err != nil {
				t.Fatal(err)
			}
			out := []string{}
			for _, n := range ns {
				out = append(out, n.PrimaryAlias)
			}
			return out
		}
		av, bv := Viewer{UserID: alice.ID}, Viewer{UserID: bob.ID}
		want := []string{"alpha", "empty", "zeta", "plain", "mid"}
		for name, f := range map[string]ListFilter{
			"all":    {Scope: ScopeAll},
			"mine":   {Scope: ScopeMine},
			"folder": {Scope: ScopeAll, Folder: folder.ID},
			"tag":    {Scope: ScopeAll, Tag: "t"},
		} {
			if got := aliases(av, f); !slices.Equal(got, want) {
				t.Errorf("%s: %v, want %v", name, got, want)
			}
		}
		var paged []string
		for off := 0; off < 6; off += 2 {
			paged = append(paged, aliases(av, ListFilter{Scope: ScopeAll, Limit: 2, Offset: off})...)
		}
		if !slices.Equal(paged, want) {
			t.Errorf("pages: %v, want %v", paged, want)
		}
		if got, want := aliases(bv, ListFilter{Scope: ScopeAll}), []string{"plain", "mid", "empty", "alpha", "zeta"}; !slices.Equal(got, want) {
			t.Errorf("bob: %v, want %v", got, want)
		}
		if got, want := aliases(av, ListFilter{Scope: ScopeRecent}), []string{"empty", "alpha", "zeta", "mid"}; !slices.Equal(got, want) {
			t.Errorf("recent: %v, want %v", got, want)
		}
		search := []string{ids["zeta"], ids["mid"], ids["alpha"]}
		if got, want := aliases(av, ListFilter{Scope: ScopeAll, IDs: search}), []string{"zeta", "mid", "alpha"}; !slices.Equal(got, want) {
			t.Errorf("search: %v, want %v", got, want)
		}
	})
}

func TestSharedCountsBuiltinGroups(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		alice, _ := st.UpsertOIDCUser(ctx, "a", "alice", "Alice", "", nil)
		bob, _ := st.UpsertOIDCUser(ctx, "b", "bob", "Bob", "", nil)
		_, _ = st.CreateNote(ctx, NewNote{OwnerID: alice.ID, Alias: "signed-in", Groups: map[string]permission.Level{GroupSignedIn: permission.Write}})
		_, _ = st.CreateNote(ctx, NewNote{OwnerID: alice.ID, Alias: "everyone", Groups: map[string]permission.Level{GroupEveryone: permission.Read}})
		_, _ = st.CreateNote(ctx, NewNote{OwnerID: bob.ID, Alias: "bob-own", Groups: map[string]permission.Level{GroupSignedIn: permission.Read}})
		f, _ := st.CreateFolder(ctx, NewFolder{Name: "Open", OwnerID: alice.ID, Groups: map[string]permission.Level{GroupSignedIn: permission.Read}})
		_, _ = st.CreateFolder(ctx, NewFolder{Name: "Mine", OwnerID: bob.ID, Groups: map[string]permission.Level{GroupSignedIn: permission.Read}})

		bv := Viewer{UserID: bob.ID}
		ns, err := st.ListNotes(ctx, ListFilter{Viewer: bv, Scope: ScopeShared})
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, n := range ns {
			got = append(got, n.PrimaryAlias)
		}
		slices.Sort(got)
		if !slices.Equal(got, []string{"everyone", "signed-in"}) {
			t.Fatalf("shared notes: %v", got)
		}
		fs, err := st.ListFolders(ctx, FolderFilter{Viewer: bv, Scope: ScopeShared})
		if err != nil || len(fs) != 1 || fs[0].ID != f.ID {
			t.Fatalf("shared folders: %v %v", fs, err)
		}
	})
}

func TestSharedEmptyInLocalMode(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		_, _ = st.CreateNote(ctx, NewNote{Alias: "pub", Groups: map[string]permission.Level{GroupEveryone: permission.Read}})
		_, _ = st.CreateFolder(ctx, NewFolder{Name: "Pub", Groups: map[string]permission.Level{GroupEveryone: permission.Read}})
		lv := Viewer{Local: true}
		if ns, err := st.ListNotes(ctx, ListFilter{Viewer: lv, Scope: ScopeShared}); err != nil || len(ns) != 0 {
			t.Fatalf("local shared notes: %v %v", ns, err)
		}
		if fs, err := st.ListFolders(ctx, FolderFilter{Viewer: lv, Scope: ScopeShared}); err != nil || len(fs) != 0 {
			t.Fatalf("local shared folders: %v %v", fs, err)
		}
	})
}

func TestListNotesByTitleAndVisit(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		alice, _ := st.UpsertOIDCUser(ctx, "a", "alice", "Alice", "", nil)
		bob, _ := st.UpsertOIDCUser(ctx, "b", "bob", "Bob", "", nil)
		note := func(owner *User, alias, title, content string) *Note {
			n, err := st.CreateNote(ctx, NewNote{OwnerID: owner.ID, Alias: alias, Content: content})
			if err != nil {
				t.Fatal(err)
			}
			_ = st.SaveNoteState(ctx, n.ID, NoteState{Title: title, Content: content})
			return n
		}
		target := note(alice, "target", "Zebra target", "")
		other := note(alice, "other", "Other ZEBRA", "")
		note(alice, "body", "Body", "zebra in the text only")
		note(alice, "never", "Zebra never opened", "")
		note(bob, "secret", "Zebra secret", "")
		note(alice, "percent", "100% sure", "")
		visit := func(n *Note, at string) {
			if _, err := st.db.Exec(st.q(`INSERT INTO note_visit (user_id, note_id, visited_at) VALUES (?, ?, ?)`), alice.ID, n.ID, at); err != nil {
				t.Fatal(err)
			}
		}
		visit(target, "2026-01-01T10:00:00.000000Z")
		visit(other, "2026-01-02T10:00:00.000000Z")
		aliases := func(title string) []string {
			ns, err := st.ListNotes(ctx, ListFilter{Viewer: Viewer{UserID: alice.ID}, Scope: ScopeAll, Title: title, Sort: SortVisited})
			if err != nil {
				t.Fatal(err)
			}
			var out []string
			for _, n := range ns {
				out = append(out, n.PrimaryAlias)
			}
			return out
		}
		if got := aliases("zebra"); !slices.Equal(got, []string{"other", "target", "never"}) {
			t.Fatalf("zebra: %v", got)
		}
		if got := aliases("ZEB tar"); !slices.Equal(got, []string{"target"}) {
			t.Fatalf("two words: %v", got)
		}
		if got := aliases("%"); !slices.Equal(got, []string{"percent"}) {
			t.Fatalf("percent: %v", got)
		}
		if got := aliases(""); len(got) != 5 || got[0] != "other" || got[1] != "target" {
			t.Fatalf("empty: %v", got)
		}
	})
}
