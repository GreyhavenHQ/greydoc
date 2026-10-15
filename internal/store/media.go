package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/greyhavenhq/greydoc/internal/secrets"
)

type Media struct {
	ID          string `json:"id"`
	NoteID      string `json:"note_id"`
	StoredName  string `json:"stored_name"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
	UploadedBy  string `json:"uploaded_by"`
	CreatedAt   string `json:"created_at"`
}

func (s *Store) AddMedia(ctx context.Context, m *Media) error {
	m.ID, m.CreatedAt = secrets.NewID(), Now()
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO media (id, note_id, stored_name, filename, content_type, size, uploaded_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`), m.ID, m.NoteID, m.StoredName, m.Filename, m.ContentType, m.Size, m.UploadedBy, m.CreatedAt)
	return err
}

func (s *Store) NoteMedia(ctx context.Context, noteID string) ([]Media, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT id, note_id, stored_name, filename, content_type, size, uploaded_by, created_at
		FROM media WHERE note_id = ? ORDER BY created_at`), noteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Media{}
	for rows.Next() {
		var m Media
		if err := rows.Scan(&m.ID, &m.NoteID, &m.StoredName, &m.Filename, &m.ContentType, &m.Size, &m.UploadedBy, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// UploadTicket lets one file be uploaded to a note without a session, for agents that run curl.
type UploadTicket struct {
	Hash        string
	NoteID      string
	UserID      string
	DisplayName string
	Client      string
	Filename    string
	ExpiresAt   string
}

func (s *Store) CreateUploadTicket(ctx context.Context, t UploadTicket) error {
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO upload_ticket (token_hash, note_id, user_id, display_name, client, filename, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`), t.Hash, t.NoteID, t.UserID, t.DisplayName, t.Client, t.Filename, t.ExpiresAt)
	return err
}

// UploadTicket returns a ticket that is not used and not expired.
func (s *Store) UploadTicket(ctx context.Context, hash string) (*UploadTicket, error) {
	t := UploadTicket{Hash: hash}
	err := s.db.QueryRowContext(ctx, s.q(`SELECT note_id, user_id, display_name, client, filename, expires_at FROM upload_ticket
		WHERE token_hash = ? AND expires_at > ?`), hash, Now()).Scan(&t.NoteID, &t.UserID, &t.DisplayName, &t.Client, &t.Filename, &t.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &t, err
}

// ConsumeUploadTicket uses a ticket up. Only one caller gets true.
func (s *Store) ConsumeUploadTicket(ctx context.Context, hash string) (bool, error) {
	res, err := s.db.ExecContext(ctx, s.q(`DELETE FROM upload_ticket WHERE token_hash = ? AND expires_at > ?`), hash, Now())
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}
