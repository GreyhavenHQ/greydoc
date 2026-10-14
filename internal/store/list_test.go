package store

import (
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

		viewer := Viewer{UserID: alice.ID, Groups: alice.Groups}
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
		if got := aliases(ListFilter{Scope: ScopeAll}); len(got) != 4 || contains(got, "private") {
			t.Fatalf("all: %v", got)
		}
		if got := aliases(ListFilter{Scope: ScopeMine}); len(got) != 1 || got[0] != own.PrimaryAlias {
			t.Fatalf("mine: %v", got)
		}
		if got := aliases(ListFilter{Scope: ScopeShared}); len(got) != 2 || !contains(got, "bob-shared") || !contains(got, "eng-note") {
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
		if err != nil || len(tags) != 2 || tags[0].Tag != "design" || tags[0].Count != 2 {
			t.Fatalf("tags %+v %v", tags, err)
		}
		local, _ := st.ListNotes(ctx, ListFilter{Scope: ScopeAll, Viewer: Viewer{Local: true}})
		if len(local) != 5 {
			t.Fatalf("local sees %d", len(local))
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
