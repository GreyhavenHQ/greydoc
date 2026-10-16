package store

import (
	"reflect"
	"sort"
	"testing"
)

func TestNotificationsListAndRead(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		a, _ := st.UpsertOIDCUser(ctx, "a", "alice", "Alice", "", nil)
		b, _ := st.UpsertOIDCUser(ctx, "b", "bob", "Bob", "", nil)
		n, _ := st.CreateNote(ctx, NewNote{Alias: "plan", OwnerID: b.ID})
		_ = st.SaveNoteState(ctx, n.ID, NoteState{Title: "Plan"})
		other, _ := st.CreateNote(ctx, NewNote{Alias: "old", OwnerID: b.ID})
		err := st.CreateNotifications(ctx, []Notification{
			{UserID: a.ID, NoteID: n.ID, Kind: "document", ActorID: b.ID, ActorName: "Bob", Excerpt: "hi"},
			{UserID: a.ID, NoteID: n.ID, Kind: "comment", ActorID: b.ID, ActorName: "Bob", Ref: "t1"},
			{UserID: a.ID, NoteID: other.ID, Kind: "suggestion", ActorID: b.ID, ActorName: "Bob", Ref: "s1"},
		})
		if err != nil {
			t.Fatal(err)
		}
		_ = st.TrashNote(ctx, other.ID, b.ID, nil)
		list, err := st.Notifications(ctx, a.ID, 50)
		if err != nil || len(list) != 2 {
			t.Fatalf("list %+v %v", list, err)
		}
		if list[0].Kind != "comment" || list[0].NoteAlias != "plan" || list[0].NoteTitle != "Plan" || list[0].Ref != "t1" || list[0].ReadAt != "" {
			t.Fatalf("newest first with note info: %+v", list[0])
		}
		if c, _ := st.UnreadNotifications(ctx, a.ID); c != 2 {
			t.Fatalf("unread %d", c)
		}
		if c, _ := st.UnreadNotifications(ctx, b.ID); c != 0 {
			t.Fatalf("bob unread %d", c)
		}
		if err := st.MarkNotificationsRead(ctx, b.ID, []string{list[0].ID}); err != nil {
			t.Fatal(err)
		}
		if c, _ := st.UnreadNotifications(ctx, a.ID); c != 2 {
			t.Fatalf("bob marked alice's: %d", c)
		}
		_ = st.MarkNotificationsRead(ctx, a.ID, []string{list[0].ID})
		if c, _ := st.UnreadNotifications(ctx, a.ID); c != 1 {
			t.Fatalf("after one read %d", c)
		}
		_ = st.MarkNotificationsRead(ctx, a.ID, nil)
		if c, _ := st.UnreadNotifications(ctx, a.ID); c != 0 {
			t.Fatalf("after all read %d", c)
		}
		if list, _ := st.Notifications(ctx, a.ID, 50); list[0].ReadAt == "" {
			t.Fatalf("read_at not set: %+v", list[0])
		}
	})
}

func TestMentionSet(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		a, _ := st.UpsertOIDCUser(ctx, "a", "alice", "", "", nil)
		b, _ := st.UpsertOIDCUser(ctx, "b", "bob", "", "", nil)
		n, _ := st.CreateNote(ctx, NewNote{})
		if got, err := st.MentionSet(ctx, n.ID); err != nil || len(got) != 0 {
			t.Fatalf("empty %v %v", got, err)
		}
		if err := st.ReplaceMentionSet(ctx, n.ID, []string{a.ID, b.ID}); err != nil {
			t.Fatal(err)
		}
		_ = st.ReplaceMentionSet(ctx, n.ID, []string{b.ID})
		if got, _ := st.MentionSet(ctx, n.ID); !reflect.DeepEqual(got, []string{b.ID}) {
			t.Fatalf("replace %v", got)
		}
		if err := st.AddMentions(ctx, n.ID, []string{a.ID, b.ID}); err != nil {
			t.Fatal(err)
		}
		got, _ := st.MentionSet(ctx, n.ID)
		sort.Strings(got)
		want := []string{a.ID, b.ID}
		sort.Strings(want)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("add %v", got)
		}
	})
}

func TestUsersByUsername(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		_, _ = st.UpsertOIDCUser(ctx, "a", "alice", "Alice Martin", "", []string{"eng"})
		_, _ = st.UpsertOIDCUser(ctx, "b", "bob", "Bob", "", nil)
		got, err := st.UsersByUsername(ctx, []string{"alice", "nobody", "ALICE"})
		if err != nil || len(got) != 1 || got[0].DisplayName != "Alice Martin" || !reflect.DeepEqual(got[0].Groups, []string{"eng"}) {
			t.Fatalf("%+v %v", got, err)
		}
		if got, _ := st.UsersByUsername(ctx, nil); len(got) != 0 {
			t.Fatalf("empty %+v", got)
		}
	})
}
