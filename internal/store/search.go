package store

import (
	"context"
	"strings"
)

// SearchNoteIDs matches title, tags and body. Step 14 replaces this with full-text indexes.
func (s *Store) SearchNoteIDs(ctx context.Context, q string, limit int) ([]string, error) {
	like := "%" + strings.ToLower(strings.TrimSpace(q)) + "%"
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT n.id FROM note n WHERE LOWER(n.title) LIKE ? OR LOWER(n.content) LIKE ?
		OR EXISTS (SELECT 1 FROM note_tag t WHERE t.note_id = n.id AND LOWER(t.tag) LIKE ?) ORDER BY n.updated_at DESC LIMIT ?`),
		like, like, like, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
