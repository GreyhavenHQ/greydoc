package store

import (
	"context"
	"database/sql"
	"errors"
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
		res, err := tx.ExecContext(ctx, s.q(`UPDATE note SET deleted_at = NULL, deleted_by = '', trashed_with = '',
			folder_id = CASE WHEN EXISTS (SELECT 1 FROM folder f WHERE f.id = note.folder_id AND f.deleted_at IS NULL) THEN folder_id ELSE NULL END
			WHERE id = ? AND deleted_at IS NOT NULL`), id)
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
		WHERE n.deleted_at IS NOT NULL AND n.trashed_with = '' AND `+where+` ORDER BY n.deleted_at DESC`), args...)
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

// TrashFolder trashes a folder with the items below it that share its owner. Items of other owners move to the top level.
// It returns the notes it trashed and the notes it moved out.
func (s *Store) TrashFolder(ctx context.Context, id, by string, ev *Event) (trashed, detached []string, err error) {
	err = s.tx(ctx, func(tx *sql.Tx) error {
		trashed, detached = nil, nil
		var owner string
		if err := tx.QueryRowContext(ctx, s.q(`SELECT COALESCE(owner_id, '') FROM folder WHERE id = ? AND deleted_at IS NULL`), id).Scan(&owner); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		rows, err := tx.QueryContext(ctx, s.q(`SELECT id, COALESCE(parent_id, ''), COALESCE(owner_id, '') FROM folder
			WHERE deleted_at IS NULL AND id IN (`+subtreeSQL+`)`), id)
		if err != nil {
			return err
		}
		children := map[string][]string{}
		owners := map[string]string{}
		for rows.Next() {
			var fid, parent, o string
			if err := rows.Scan(&fid, &parent, &o); err != nil {
				rows.Close()
				return err
			}
			children[parent] = append(children[parent], fid)
			owners[fid] = o
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		folders := []string{id}
		for i := 0; i < len(folders); i++ {
			for _, c := range children[folders[i]] {
				if owners[c] == owner {
					folders = append(folders, c)
				} else if _, err := tx.ExecContext(ctx, s.q(`UPDATE folder SET parent_id = NULL WHERE id = ?`), c); err != nil {
					return err
				}
			}
		}
		now := Now()
		for _, fid := range folders {
			rows, err := tx.QueryContext(ctx, s.q(`SELECT id, COALESCE(owner_id, '') FROM note WHERE folder_id = ? AND deleted_at IS NULL`), fid)
			if err != nil {
				return err
			}
			for rows.Next() {
				var nid, o string
				if err := rows.Scan(&nid, &o); err != nil {
					rows.Close()
					return err
				}
				if o == owner {
					trashed = append(trashed, nid)
				} else {
					detached = append(detached, nid)
				}
			}
			rows.Close()
			if _, err := tx.ExecContext(ctx, s.q(`UPDATE folder SET deleted_at = ?, deleted_by = ?, trashed_with = ? WHERE id = ?`), now, by, id, fid); err != nil {
				return err
			}
		}
		for _, nid := range trashed {
			if _, err := tx.ExecContext(ctx, s.q(`UPDATE note SET deleted_at = ?, deleted_by = ?, trashed_with = ? WHERE id = ?`), now, by, id, nid); err != nil {
				return err
			}
		}
		for _, nid := range detached {
			if _, err := tx.ExecContext(ctx, s.q(`UPDATE note SET folder_id = NULL WHERE id = ?`), nid); err != nil {
				return err
			}
		}
		return s.insertEvent(ctx, tx, ev)
	})
	return trashed, detached, err
}

// RestoreFolder brings back a trashed folder with everything trashed with it. It goes to the top level if its parent is gone.
func (s *Store) RestoreFolder(ctx context.Context, id string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, s.q(`UPDATE folder SET deleted_at = NULL, deleted_by = '', trashed_with = '' WHERE trashed_with = ?`), id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE folder SET parent_id = NULL WHERE id = ?
			AND NOT EXISTS (SELECT 1 FROM folder p WHERE p.id = folder.parent_id AND p.deleted_at IS NULL)`), id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE note SET deleted_at = NULL, deleted_by = '', trashed_with = '' WHERE trashed_with = ?`), id); err != nil {
			return err
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

// FolderTrashNotes lists the notes trashed together with a folder.
func (s *Store) FolderTrashNotes(ctx context.Context, id string) ([]string, error) {
	return s.ids(ctx, s.db, `SELECT id FROM note WHERE trashed_with = ?`, id)
}

// PurgeFolder deletes a trashed folder and its trashed subfolders. The caller purges the notes first.
func (s *Store) PurgeFolder(ctx context.Context, id string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		// A subfolder trashed on its own keeps its own unit.
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE folder SET parent_id = NULL WHERE trashed_with <> ?
			AND parent_id IN (SELECT id FROM folder WHERE trashed_with = ?)`), id, id); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, s.q(`DELETE FROM folder WHERE trashed_with = ?`), id)
		return err
	})
}

type TrashedFolder struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	OwnerName string `json:"owner"`
	DeletedAt string `json:"deleted_at"`
	DeletedBy string `json:"deleted_by"`
	Notes     int    `json:"notes"`
}

// TrashFolders lists folders the viewer trashed as a unit: their own, or all for local mode and admins.
func (s *Store) TrashFolders(ctx context.Context, v Viewer) ([]TrashedFolder, error) {
	where, args := "1 = 1", []any{}
	if !v.Local && !v.Admin {
		where, args = "f.owner_id = ?", []any{v.UserID}
	}
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT f.id, f.name, COALESCE(u.display_name, ''), f.deleted_at, f.deleted_by,
		(SELECT COUNT(*) FROM note n WHERE n.trashed_with = f.id)
		FROM folder f LEFT JOIN app_user u ON u.id = f.owner_id
		WHERE f.deleted_at IS NOT NULL AND f.trashed_with = f.id AND `+where+` ORDER BY f.deleted_at DESC`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TrashedFolder{}
	for rows.Next() {
		var t TrashedFolder
		if err := rows.Scan(&t.ID, &t.Name, &t.OwnerName, &t.DeletedAt, &t.DeletedBy, &t.Notes); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) TrashedFoldersBefore(ctx context.Context, t time.Time) ([]string, error) {
	return s.ids(ctx, s.db, `SELECT id FROM folder WHERE deleted_at IS NOT NULL AND trashed_with = id AND deleted_at < ?`, FormatTime(t))
}
