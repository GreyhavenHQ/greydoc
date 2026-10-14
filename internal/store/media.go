package store

import (
	"context"

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
