package store

import (
	"testing"
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
