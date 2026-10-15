package store

import (
	"context"
	"database/sql"
	"errors"
)

type NoteUpdate struct {
	ID        int64
	UserID    string
	Name      string
	Source    Source
	ClientID  uint64
	Data      []byte
	CreatedAt string
}

func (s *Store) AppendUpdates(ctx context.Context, noteID string, ups []NoteUpdate) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		for _, u := range ups {
			at := u.CreatedAt
			if at == "" {
				at = Now()
			}
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO note_update (note_id, user_id, display_name, source, client_id, data, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`), noteID, u.UserID, u.Name, string(u.Source), int64(u.ClientID), u.Data, at); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) scanUpdates(rows *sql.Rows) ([]NoteUpdate, error) {
	defer rows.Close()
	var out []NoteUpdate
	for rows.Next() {
		var u NoteUpdate
		var src string
		var cid int64
		if err := rows.Scan(&u.ID, &u.UserID, &u.Name, &src, &cid, &u.Data, &u.CreatedAt); err != nil {
			return nil, err
		}
		u.Source, u.ClientID = Source(src), uint64(cid)
		out = append(out, u)
	}
	return out, rows.Err()
}

const updateColumns = `u.id, u.user_id, u.display_name, u.source, u.client_id, u.data, u.created_at`

// UpdatesAfterSnapshot returns logged updates the stored snapshot does not include.
func (s *Store) UpdatesAfterSnapshot(ctx context.Context, noteID string) ([]NoteUpdate, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT `+updateColumns+` FROM note_update u JOIN note n ON n.id = u.note_id
		WHERE u.note_id = ? AND u.id > n.ystate_upto ORDER BY u.id`), noteID)
	if err != nil {
		return nil, err
	}
	return s.scanUpdates(rows)
}

// UpdatesBetween returns updates with afterID < id <= uptoID (uptoID 0 means no upper bound).
func (s *Store) UpdatesBetween(ctx context.Context, noteID string, afterID, uptoID int64) ([]NoteUpdate, error) {
	q := `SELECT ` + updateColumns + ` FROM note_update u WHERE u.note_id = ? AND u.id > ?`
	args := []any{noteID, afterID}
	if uptoID > 0 {
		q += ` AND u.id <= ?`
		args = append(args, uptoID)
	}
	rows, err := s.db.QueryContext(ctx, s.q(q+` ORDER BY u.id`), args...)
	if err != nil {
		return nil, err
	}
	return s.scanUpdates(rows)
}

// MergeSnapshot saves a snapshot that includes the stored one and every update logged after it,
// so a save never drops edits that another server logged. merge builds the state from those parts.
func (s *Store) MergeSnapshot(ctx context.Context, noteID string, merge func(stored []byte, pending [][]byte) (NoteState, error)) error {
	for range 5 {
		var stored []byte
		var upto int64
		err := s.db.QueryRowContext(ctx, s.q(`SELECT ystate, ystate_upto FROM note WHERE id = ?`), noteID).Scan(&stored, &upto)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		ups, err := s.UpdatesBetween(ctx, noteID, upto, 0)
		if err != nil {
			return err
		}
		pending := make([][]byte, len(ups))
		next := upto
		for i, u := range ups {
			pending[i] = u.Data
			next = u.ID
		}
		st, err := merge(stored, pending)
		if err != nil {
			return err
		}
		if err := s.saveNoteState(ctx, noteID, st, upto, next); !errors.Is(err, ErrConflict) {
			return err
		}
	}
	return ErrConflict
}

// SaveSnapshot stores the Yjs state and derived fields, and marks every logged update as included.
func (s *Store) SaveSnapshot(ctx context.Context, noteID string, ystate []byte, st NoteState) error {
	var upto int64
	if err := s.db.QueryRowContext(ctx, s.q(`SELECT COALESCE(MAX(id), 0) FROM note_update WHERE note_id = ?`), noteID).Scan(&upto); err != nil {
		return err
	}
	st.YState = ystate
	if err := s.SaveNoteState(ctx, noteID, st); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, s.q(`UPDATE note SET ystate_upto = ? WHERE id = ? AND ystate_upto < ?`), upto, noteID, upto)
	return err
}

type NoteClient struct {
	ClientID    uint64 `json:"client_id"`
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	Source      Source `json:"source"`
	CreatedAt   string `json:"created_at"`
}

func (s *Store) RegisterClient(ctx context.Context, noteID string, c NoteClient) error {
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO note_client (note_id, client_id, user_id, display_name, source, created_at)
		VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (note_id, client_id) DO NOTHING`),
		noteID, int64(c.ClientID), c.UserID, c.DisplayName, string(c.Source), Now())
	return err
}

func (s *Store) NoteClients(ctx context.Context, noteID string) ([]NoteClient, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT client_id, user_id, display_name, source, created_at FROM note_client
		WHERE note_id = ? ORDER BY created_at`), noteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []NoteClient{}
	for rows.Next() {
		var c NoteClient
		var cid int64
		var src string
		if err := rows.Scan(&cid, &c.UserID, &c.DisplayName, &src, &c.CreatedAt); err != nil {
			return nil, err
		}
		c.ClientID, c.Source = uint64(cid), Source(src)
		out = append(out, c)
	}
	return out, rows.Err()
}
