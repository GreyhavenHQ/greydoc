package store

import (
	"errors"
	"slices"
	"testing"

	"github.com/greyhavenhq/greydoc/internal/permission"
)

func TestFolderChainAndCycle(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		a, _ := st.CreateFolder(ctx, NewFolder{Name: "a"})
		b, _ := st.CreateFolder(ctx, NewFolder{Name: "b", ParentID: a.ID})
		c, _ := st.CreateFolder(ctx, NewFolder{Name: "c", ParentID: b.ID})
		chain, err := st.FolderChain(ctx, c.ID)
		if err != nil || len(chain) != 3 || chain[0].ID != a.ID || chain[2].ID != c.ID {
			t.Fatalf("chain: %v %v", chain, err)
		}
		if err := st.MoveFolder(ctx, a.ID, c.ID, nil); !errors.Is(err, ErrFolderCycle) {
			t.Fatalf("cycle: %v", err)
		}
		if err := st.MoveFolder(ctx, a.ID, a.ID, nil); !errors.Is(err, ErrFolderCycle) {
			t.Fatalf("self: %v", err)
		}
		if err := st.MoveFolder(ctx, c.ID, "", nil); err != nil {
			t.Fatal(err)
		}
		if chain, _ := st.FolderChain(ctx, c.ID); len(chain) != 1 {
			t.Fatalf("moved to top: %v", chain)
		}
	})
}

func TestFolderDepthLimit(t *testing.T) {
	st := OpenTest(t)
	parent := ""
	for i := 0; i < MaxFolderDepth; i++ {
		f, err := st.CreateFolder(ctx, NewFolder{Name: "x", ParentID: parent})
		if err != nil {
			t.Fatalf("level %d: %v", i, err)
		}
		parent = f.ID
	}
	if _, err := st.CreateFolder(ctx, NewFolder{Name: "x", ParentID: parent}); !errors.Is(err, ErrFolderDepth) {
		t.Fatalf("too deep: %v", err)
	}
}

func TestListNotesThroughFolders(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		alice, _ := st.UpsertOIDCUser(ctx, "a", "alice", "Alice", "", nil)
		bob, _ := st.UpsertOIDCUser(ctx, "b", "bob", "Bob", "", []string{"eng"})
		top, _ := st.CreateFolder(ctx, NewFolder{Name: "Project", OwnerID: alice.ID})
		sub, _ := st.CreateFolder(ctx, NewFolder{Name: "Specs", OwnerID: alice.ID, ParentID: top.ID})
		other, _ := st.CreateFolder(ctx, NewFolder{Name: "Secret", OwnerID: alice.ID})
		deep, _ := st.CreateNote(ctx, NewNote{OwnerID: alice.ID, Alias: "deep", FolderID: sub.ID})
		_, _ = st.CreateNote(ctx, NewNote{OwnerID: alice.ID, Alias: "hidden", FolderID: other.ID})
		direct, _ := st.CreateNote(ctx, NewNote{OwnerID: alice.ID, Alias: "direct", FolderID: other.ID})
		_ = st.SetUserGrant(ctx, direct.ID, bob.ID, permission.Read, nil)
		_ = st.SetFolderGroupGrant(ctx, top.ID, "eng", permission.Read, nil)

		bv := Viewer{UserID: bob.ID, Groups: bob.Groups}
		ns, err := st.ListNotes(ctx, ListFilter{Viewer: bv, Scope: ScopeAll})
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]NoteSummary{}
		for _, n := range ns {
			got[n.PrimaryAlias] = n
		}
		if len(got) != 2 || got["deep"].ID != deep.ID {
			t.Fatalf("bob sees: %v", got)
		}
		if got["deep"].FolderName != "Specs" || got["direct"].FolderName != "" {
			t.Fatalf("folder names: %+v", got)
		}
		if ns, _ := st.ListNotes(ctx, ListFilter{Viewer: bv, Scope: ScopeShared}); len(ns) != 1 || ns[0].PrimaryAlias != "direct" {
			t.Fatalf("shared notes: %v", ns)
		}
		fs, err := st.ListFolders(ctx, FolderFilter{Viewer: bv, Scope: ScopeShared})
		if err != nil || len(fs) != 1 || fs[0].ID != top.ID || !fs[0].HasChildren {
			t.Fatalf("shared folders: %v %v", fs, err)
		}
		av := Viewer{UserID: alice.ID}
		if fs, _ := st.ListFolders(ctx, FolderFilter{Viewer: av, Scope: ScopeMine}); len(fs) != 2 {
			t.Fatalf("alice top folders: %v", fs)
		}
		if ns, _ := st.ListNotes(ctx, ListFilter{Viewer: av, Scope: ScopeMine, Folder: FolderRoot}); len(ns) != 0 {
			t.Fatalf("alice top notes: %v", ns)
		}
		if ns, _ := st.ListNotes(ctx, ListFilter{Viewer: av, Folder: sub.ID}); len(ns) != 1 {
			t.Fatalf("folder notes: %v", ns)
		}
		if tags, err := st.TagCounts(ctx, bv); err != nil {
			t.Fatal(tags, err)
		}
	})
}

func TestTrashFolderUnit(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		alice, _ := st.UpsertOIDCUser(ctx, "a", "alice", "Alice", "", nil)
		bob, _ := st.UpsertOIDCUser(ctx, "b", "bob", "Bob", "", nil)
		top, _ := st.CreateFolder(ctx, NewFolder{Name: "Project", OwnerID: alice.ID})
		sub, _ := st.CreateFolder(ctx, NewFolder{Name: "Sub", OwnerID: alice.ID, ParentID: top.ID})
		bobs, _ := st.CreateFolder(ctx, NewFolder{Name: "Bob's", OwnerID: bob.ID, ParentID: top.ID})
		mine, _ := st.CreateNote(ctx, NewNote{OwnerID: alice.ID, Alias: "mine", FolderID: sub.ID})
		his, _ := st.CreateNote(ctx, NewNote{OwnerID: bob.ID, Alias: "his", FolderID: top.ID})
		inBobs, _ := st.CreateNote(ctx, NewNote{OwnerID: alice.ID, Alias: "in-bobs", FolderID: bobs.ID})

		trashed, detached, err := st.TrashFolder(ctx, top.ID, "Alice", nil)
		if err != nil || len(trashed) != 1 || trashed[0] != mine.ID || len(detached) != 1 || detached[0] != his.ID {
			t.Fatalf("trash: %v %v %v", trashed, detached, err)
		}
		if n, _ := st.NoteByID(ctx, his.ID); n.FolderID != "" || n.DeletedAt != "" {
			t.Fatalf("bob's note: %+v", n)
		}
		if f, _ := st.FolderByID(ctx, bobs.ID); f.ParentID != "" || f.DeletedAt != "" {
			t.Fatalf("bob's folder: %+v", f)
		}
		if n, _ := st.NoteByID(ctx, inBobs.ID); n.DeletedAt != "" {
			t.Fatal("a note in bob's folder was trashed")
		}
		av := Viewer{UserID: alice.ID}
		if tf, _ := st.TrashFolders(ctx, av); len(tf) != 1 || tf[0].Notes != 1 {
			t.Fatalf("trash folders: %v", tf)
		}
		if tn, _ := st.Trash(ctx, av); len(tn) != 0 {
			t.Fatalf("trashed notes listed one by one: %v", tn)
		}
		if err := st.RestoreFolder(ctx, top.ID, nil); err != nil {
			t.Fatal(err)
		}
		if n, _ := st.NoteByID(ctx, mine.ID); n.DeletedAt != "" || n.FolderID != sub.ID {
			t.Fatalf("restored note: %+v", n)
		}
		if f, _ := st.FolderByID(ctx, sub.ID); f.DeletedAt != "" {
			t.Fatal("subfolder not restored")
		}

		if _, _, err := st.TrashFolder(ctx, top.ID, "Alice", nil); err != nil {
			t.Fatal(err)
		}
		ids, _ := st.FolderTrashNotes(ctx, top.ID)
		for _, id := range ids {
			_ = st.DeleteNote(ctx, id)
		}
		if err := st.PurgeFolder(ctx, top.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := st.FolderByID(ctx, sub.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("subfolder survived: %v", err)
		}
	})
}

func TestGroupFilterThroughFolders(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		alice, _ := st.UpsertOIDCUser(ctx, "a", "alice", "Alice", "", nil)
		top, _ := st.CreateFolder(ctx, NewFolder{Name: "Shared", OwnerID: alice.ID})
		sub, _ := st.CreateFolder(ctx, NewFolder{Name: "Sub", OwnerID: alice.ID, ParentID: top.ID})
		_ = st.SetFolderGroupGrant(ctx, top.ID, "g1", permission.Read, nil)
		_, _ = st.CreateNote(ctx, NewNote{OwnerID: alice.ID, Alias: "in-sub", FolderID: sub.ID})
		_, _ = st.CreateNote(ctx, NewNote{OwnerID: alice.ID, Alias: "direct", Groups: map[string]permission.Level{"g1": permission.Read}})
		_, _ = st.CreateNote(ctx, NewNote{OwnerID: alice.ID, Alias: "other"})
		ns, err := st.ListNotes(ctx, ListFilter{Viewer: Viewer{UserID: alice.ID}, Scope: ScopeAll, Group: "g1"})
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, n := range ns {
			got = append(got, n.PrimaryAlias)
		}
		if len(got) != 2 || !contains(got, "in-sub") || !contains(got, "direct") {
			t.Fatalf("group filter: %v", got)
		}
	})
}

func TestSharedFoldersTopOnly(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		alice, _ := st.UpsertOIDCUser(ctx, "a", "alice", "Alice", "", nil)
		bob, _ := st.UpsertOIDCUser(ctx, "b", "bob", "Bob", "", nil)
		top, _ := st.CreateFolder(ctx, NewFolder{Name: "Project", OwnerID: alice.ID})
		sub, _ := st.CreateFolder(ctx, NewFolder{Name: "Specs", OwnerID: alice.ID, ParentID: top.ID, Groups: map[string]permission.Level{GroupSignedIn: permission.Read}})
		private, _ := st.CreateFolder(ctx, NewFolder{Name: "Private", OwnerID: alice.ID})
		inner, _ := st.CreateFolder(ctx, NewFolder{Name: "Inner", OwnerID: alice.ID, ParentID: private.ID})
		_ = st.SetFolderUserGrant(ctx, top.ID, bob.ID, permission.Read, nil)
		_ = st.SetFolderUserGrant(ctx, sub.ID, bob.ID, permission.Read, nil)
		_ = st.SetFolderUserGrant(ctx, inner.ID, bob.ID, permission.Read, nil)

		fs, err := st.ListFolders(ctx, FolderFilter{Viewer: Viewer{UserID: bob.ID}, Scope: ScopeShared})
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, f := range fs {
			got = append(got, f.Name)
		}
		if !slices.Equal(got, []string{"Inner", "Project"}) {
			t.Fatalf("shared folders: %v", got)
		}
	})
}
