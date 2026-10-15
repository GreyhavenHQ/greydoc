package store

import (
	"errors"
	"testing"
	"time"
)

func TestUpdateLogAndSnapshotMarker(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{})
		err := st.AppendUpdates(ctx, n.ID, []NoteUpdate{
			{UserID: "u1", Name: "U1", Source: SourceHuman, ClientID: 1 << 52, Data: []byte{1}},
			{UserID: "u2", Name: "U2", Source: SourceAgent, ClientID: 7, Data: []byte{2}},
		})
		if err != nil {
			t.Fatal(err)
		}
		ups, err := st.UpdatesAfterSnapshot(ctx, n.ID)
		if err != nil || len(ups) != 2 || ups[0].ClientID != 1<<52 || ups[1].Source != SourceAgent {
			t.Fatalf("%+v %v", ups, err)
		}
		if err := st.SaveSnapshot(ctx, n.ID, []byte{9}, NoteState{Content: "x"}); err != nil {
			t.Fatal(err)
		}
		ups, _ = st.UpdatesAfterSnapshot(ctx, n.ID)
		if len(ups) != 0 {
			t.Fatalf("updates before the snapshot returned: %d", len(ups))
		}
		_ = st.AppendUpdates(ctx, n.ID, []NoteUpdate{{UserID: "u1", Source: SourceHuman, ClientID: 1, Data: []byte{3}}})
		ups, _ = st.UpdatesAfterSnapshot(ctx, n.ID)
		if len(ups) != 1 || ups[0].Data[0] != 3 {
			t.Fatalf("%+v", ups)
		}
	})
}

func TestClientRegistry(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{})
		big := uint64(1<<53 - 1)
		if err := st.RegisterClient(ctx, n.ID, NoteClient{ClientID: big, UserID: "u", DisplayName: "U", Source: SourceAIAssisted}); err != nil {
			t.Fatal(err)
		}
		if err := st.RegisterClient(ctx, n.ID, NoteClient{ClientID: big, UserID: "u", DisplayName: "U", Source: SourceAIAssisted}); err != nil {
			t.Fatalf("re-register: %v", err)
		}
		cs, err := st.NoteClients(ctx, n.ID)
		if err != nil || len(cs) != 1 || cs[0].ClientID != big || cs[0].Source != SourceAIAssisted {
			t.Fatalf("%+v %v", cs, err)
		}
	})
}

func TestMergeSnapshotRetriesWhenAnotherServerSaved(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{})
		_ = st.AppendUpdates(ctx, n.ID, []NoteUpdate{{UserID: "a", Source: SourceHuman, ClientID: 1, Data: []byte{1}}})
		calls := 0
		err := st.MergeSnapshot(ctx, n.ID, func(stored []byte, pending [][]byte) (NoteState, error) {
			calls++
			if calls == 1 {
				// Another server logs an update and saves in between.
				_ = st.AppendUpdates(ctx, n.ID, []NoteUpdate{{UserID: "b", Source: SourceHuman, ClientID: 2, Data: []byte{2}}})
				if err := st.MergeSnapshot(ctx, n.ID, func(_ []byte, p [][]byte) (NoteState, error) {
					return NoteState{YState: []byte{byte(len(p))}, Content: "other"}, nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			return NoteState{YState: append(append([]byte{}, stored...), byte(len(pending))), Content: "mine"}, nil
		})
		if err != nil || calls != 2 {
			t.Fatalf("calls %d, err %v", calls, err)
		}
		got, _ := st.NoteByID(ctx, n.ID)
		if got.Content != "mine" || string(got.YState) != string([]byte{2, 0}) {
			t.Fatalf("%q %v", got.Content, got.YState)
		}
		if ups, _ := st.UpdatesAfterSnapshot(ctx, n.ID); len(ups) != 0 {
			t.Fatalf("%d updates left after the snapshot", len(ups))
		}
	})
}

func TestCommitHistoryOnce(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{})
		rev := &Revision{Text: "x", StartedAt: Now(), EndedAt: Now()}
		if err := st.CommitHistory(ctx, n.ID, rev, 0, 5, nil); err != nil {
			t.Fatal(err)
		}
		if err := st.CommitHistory(ctx, n.ID, rev, 0, 5, nil); !errors.Is(err, ErrConflict) {
			t.Fatalf("second commit: %v", err)
		}
		if revs, _ := st.Revisions(ctx, n.ID, 10); len(revs) != 1 {
			t.Fatalf("%d revisions", len(revs))
		}
	})
}

func TestUploadTicketIsSingleUseAndExpires(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{})
		live := UploadTicket{Hash: "h-live", NoteID: n.ID, UserID: "u", Filename: "a.png", ExpiresAt: FormatTime(time.Now().Add(time.Minute))}
		old := UploadTicket{Hash: "h-old", NoteID: n.ID, ExpiresAt: FormatTime(time.Now().Add(-time.Minute))}
		if err := st.CreateUploadTicket(ctx, live); err != nil {
			t.Fatal(err)
		}
		_ = st.CreateUploadTicket(ctx, old)
		if got, err := st.UploadTicket(ctx, "h-live"); err != nil || got.Filename != "a.png" {
			t.Fatalf("%+v %v", got, err)
		}
		if _, err := st.UploadTicket(ctx, "h-old"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("expired ticket found: %v", err)
		}
		if ok, err := st.ConsumeUploadTicket(ctx, "h-live"); !ok || err != nil {
			t.Fatalf("consume: %v %v", ok, err)
		}
		if ok, _ := st.ConsumeUploadTicket(ctx, "h-live"); ok {
			t.Fatal("consumed twice")
		}
		if ok, _ := st.ConsumeUploadTicket(ctx, "h-old"); ok {
			t.Fatal("consumed an expired ticket")
		}
	})
}
