package store

import (
	"errors"
	"slices"
	"testing"

	"github.com/greyhavenhq/greydoc/internal/permission"
)

func TestGroupKindsAndMembership(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		alice, _ := st.UpsertOIDCUser(ctx, "a", "alice", "Alice", "", []string{"eng"})
		bob, _ := st.UpsertOIDCUser(ctx, "b", "bob", "Bob", "", nil)
		design, err := st.CreateGroup(ctx, "Design", "", "", &Event{Kind: "group.create"})
		if err != nil {
			t.Fatal(err)
		}
		eng, err := st.CreateGroup(ctx, "Engineering", "", "eng", nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.CreateGroup(ctx, "design", "", "", nil); !errors.Is(err, ErrGroupNameTaken) {
			t.Fatalf("duplicate name: %v", err)
		}
		if _, err := st.CreateGroup(ctx, "Eng 2", "", "eng", nil); !errors.Is(err, ErrGroupLinkTaken) {
			t.Fatalf("duplicate link: %v", err)
		}
		if _, err := st.UpdateGroup(ctx, design.ID, "Design", "", "eng", nil); !errors.Is(err, ErrGroupKind) {
			t.Fatalf("kind change: %v", err)
		}
		if _, err := st.UpdateGroup(ctx, eng.ID, "Engineering", "", "", nil); !errors.Is(err, ErrGroupKind) {
			t.Fatalf("unlink: %v", err)
		}
		if g, err := st.UpdateGroup(ctx, design.ID, "Product design", "UX", "", nil); err != nil || g.Name != "Product design" || g.Description != "UX" {
			t.Fatalf("rename: %+v %v", g, err)
		}
		if err := st.AddGroupMember(ctx, eng.ID, bob.ID, nil); !errors.Is(err, ErrGroupLinked) {
			t.Fatalf("manual member on linked group: %v", err)
		}
		if err := st.AddGroupMember(ctx, design.ID, bob.ID, nil); err != nil {
			t.Fatal(err)
		}
		if err := st.AddGroupMember(ctx, design.ID, bob.ID, nil); err != nil {
			t.Fatalf("second add: %v", err)
		}

		a, _ := st.UserByID(ctx, alice.ID)
		b, _ := st.UserByID(ctx, bob.ID)
		if !slices.Equal(a.GroupIDs, []string{eng.ID}) || !slices.Equal(b.GroupIDs, []string{design.ID}) {
			t.Fatalf("alice %v, bob %v", a.GroupIDs, b.GroupIDs)
		}
		members, _ := st.GroupMembers(ctx, eng)
		if len(members) != 1 || members[0].Username != "alice" {
			t.Fatalf("linked members %+v", members)
		}
		gs, _ := st.Groups(ctx)
		if len(gs) != 2 || gs[0].Name != "Engineering" || gs[0].MemberCount != 1 || gs[1].MemberCount != 1 {
			t.Fatalf("groups %+v", gs)
		}

		if err := st.RemoveGroupMember(ctx, design.ID, bob.ID, nil); err != nil {
			t.Fatal(err)
		}
		if err := st.RemoveGroupMember(ctx, design.ID, bob.ID, nil); !errors.Is(err, ErrNotFound) {
			t.Fatalf("second remove: %v", err)
		}
		if b, _ := st.UserByID(ctx, bob.ID); len(b.GroupIDs) != 0 {
			t.Fatalf("bob still in %v", b.GroupIDs)
		}
	})
}

func TestDeleteGroupRemovesGrants(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		u, _ := st.UpsertOIDCUser(ctx, "a", "alice", "Alice", "", nil)
		g, _ := st.CreateGroup(ctx, "Design", "", "", nil)
		_ = st.AddGroupMember(ctx, g.ID, u.ID, nil)
		n, _ := st.CreateNote(ctx, NewNote{Alias: "spec", Groups: map[string]permission.Level{g.ID: permission.Write, GroupSignedIn: permission.Read}})
		acl, _ := st.NoteACL(ctx, n.ID)
		if len(acl.Groups) != 2 || !slices.ContainsFunc(acl.Groups, func(gg GroupGrant) bool { return gg.Group == g.ID && gg.Name == "Design" }) {
			t.Fatalf("acl %+v", acl.Groups)
		}
		if g, _ := st.GroupByName(ctx, "design"); g == nil || g.NoteCount != 1 {
			t.Fatalf("group %+v", g)
		}
		ids, err := st.DeleteGroup(ctx, g.ID, &Event{Kind: "group.delete"})
		if err != nil || !slices.Equal(ids, []string{n.ID}) {
			t.Fatalf("delete: %v %v", ids, err)
		}
		acl, _ = st.NoteACL(ctx, n.ID)
		if len(acl.Groups) != 1 || acl.Groups[0].Group != GroupSignedIn {
			t.Fatalf("acl after delete %+v", acl.Groups)
		}
		if u, _ := st.UserByID(ctx, u.ID); len(u.GroupIDs) != 0 {
			t.Fatalf("membership kept: %v", u.GroupIDs)
		}
		if _, err := st.DeleteGroup(ctx, g.ID, nil); !errors.Is(err, ErrNotFound) {
			t.Fatalf("second delete: %v", err)
		}
	})
}
