package server

import (
	"context"
	"errors"

	"github.com/greyhavenhq/greydoc/internal/collab"
	"github.com/greyhavenhq/greydoc/internal/notemeta"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// roomStore adapts the store to what the collab hub needs.
type roomStore struct{ st *store.Store }

func (rs roomStore) LoadRoom(ctx context.Context, noteID string) (*collab.RoomState, error) {
	n, err := rs.st.NoteByID(ctx, noteID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, collab.ErrNoteNotFound
	}
	if err != nil {
		return nil, err
	}
	ups, err := rs.st.UpdatesAfterSnapshot(ctx, noteID)
	if err != nil {
		return nil, err
	}
	clients, err := rs.st.NoteClients(ctx, noteID)
	if err != nil {
		return nil, err
	}
	rsState := &collab.RoomState{YState: n.YState, Content: n.Content, OwnerID: n.OwnerID}
	for _, u := range ups {
		rsState.Updates = append(rsState.Updates, u.Data)
	}
	for _, c := range clients {
		rsState.Clients = append(rsState.Clients, collab.Client{ClientID: c.ClientID, UserID: c.UserID, DisplayName: c.DisplayName, Source: string(c.Source)})
	}
	return rsState, nil
}

func (rs roomStore) SaveRoom(ctx context.Context, noteID string, ystate []byte, text string) error {
	meta := notemeta.Extract(text)
	return rs.st.SaveSnapshot(ctx, noteID, ystate, store.NoteState{
		Content: text, Title: meta.Title, Description: meta.Description, Tags: meta.Tags,
	})
}

func (rs roomStore) AppendUpdates(ctx context.Context, noteID string, recs []collab.UpdateRecord) error {
	ups := make([]store.NoteUpdate, len(recs))
	for i, r := range recs {
		ups[i] = store.NoteUpdate{UserID: r.UserID, Name: r.Name, Source: store.Source(r.Source), ClientID: r.ClientID,
			Data: r.Data, CreatedAt: store.FormatTime(r.At)}
	}
	err := rs.st.AppendUpdates(ctx, noteID, ups)
	if err != nil && errors.Is(ctx.Err(), context.Canceled) {
		return nil
	}
	return err
}

func (rs roomStore) RegisterClient(ctx context.Context, noteID string, c collab.Client) error {
	return rs.st.RegisterClient(ctx, noteID, store.NoteClient{ClientID: c.ClientID, UserID: c.UserID,
		DisplayName: c.DisplayName, Source: store.Source(c.Source)})
}
