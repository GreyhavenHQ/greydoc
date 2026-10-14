package store

import (
	"context"
	"database/sql"
	"time"
)

// TrashNote moves a note to the trash. Its aliases stay reserved until it is purged.
func (s *Store) TrashNote(ctx context.Context, id, by string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, s.q(`UPDATE note SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL`), Now(), by, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

func (s *Store) RestoreNote(ctx context.Context, id string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, s.q(`UPDATE note SET deleted_at = NULL, deleted_by = '' WHERE id = ? AND deleted_at IS NOT NULL`), id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

type TrashedNote struct {
	ID        string `json:"id"`
	Alias     string `json:"alias"`
	Title     string `json:"title"`
	OwnerName string `json:"owner"`
	DeletedAt string `json:"deleted_at"`
	DeletedBy string `json:"deleted_by"`
}

// Trash lists notes in the trash the viewer may restore: their own, or all for local mode and admins.
func (s *Store) Trash(ctx context.Context, v Viewer) ([]TrashedNote, error) {
	where, args := "1 = 1", []any{}
	if !v.Local && !v.Admin {
		where, args = "n.owner_id = ?", []any{v.UserID}
	}
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT n.id, a.name, n.title, COALESCE(u.display_name, ''), n.deleted_at, n.deleted_by
		FROM note n JOIN note_alias a ON a.note_id = n.id AND a.is_primary = 1 LEFT JOIN app_user u ON u.id = n.owner_id
		WHERE n.deleted_at IS NOT NULL AND `+where+` ORDER BY n.deleted_at DESC`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TrashedNote{}
	for rows.Next() {
		var t TrashedNote
		if err := rows.Scan(&t.ID, &t.Alias, &t.Title, &t.OwnerName, &t.DeletedAt, &t.DeletedBy); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// TrashedBefore lists notes that went to the trash before t, for purging.
func (s *Store) TrashedBefore(ctx context.Context, t time.Time) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT id FROM note WHERE deleted_at IS NOT NULL AND deleted_at < ?`), FormatTime(t))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
