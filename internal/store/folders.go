package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/secrets"
)

var (
	ErrFolderCycle = errors.New("a folder cannot move into itself or into one of its subfolders")
	ErrFolderDepth = errors.New("folders cannot be nested deeper than 32 levels")
)

// MaxFolderDepth bounds the chain walked for every access check.
const MaxFolderDepth = 32

type Folder struct {
	ID        string `json:"id"`
	ParentID  string `json:"parent_id,omitempty"`
	OwnerID   string `json:"owner_id,omitempty"`
	Name      string `json:"name"`
	DeletedAt string `json:"deleted_at,omitempty"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type NewFolder struct {
	ParentID string
	OwnerID  string
	Name     string
	Groups   map[string]permission.Level
	Event    *Event
}

const folderColumns = `f.id, COALESCE(f.parent_id, ''), COALESCE(f.owner_id, ''), f.name, COALESCE(f.deleted_at, ''), f.created_at, f.updated_at`

func scanFolder(row interface{ Scan(...any) error }) (*Folder, error) {
	var f Folder
	err := row.Scan(&f.ID, &f.ParentID, &f.OwnerID, &f.Name, &f.DeletedAt, &f.CreatedAt, &f.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &f, err
}

func (s *Store) CreateFolder(ctx context.Context, nf NewFolder) (*Folder, error) {
	now := Now()
	f := &Folder{ID: secrets.NewID(), ParentID: nf.ParentID, OwnerID: nf.OwnerID, Name: nf.Name, CreatedAt: now, UpdatedAt: now}
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if nf.ParentID != "" {
			chain, err := s.folderChain(ctx, tx, nf.ParentID)
			if err != nil {
				return err
			}
			if len(chain) >= MaxFolderDepth {
				return ErrFolderDepth
			}
		}
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO folder (id, parent_id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`),
			f.ID, nullStr(f.ParentID), nullStr(f.OwnerID), f.Name, now, now); err != nil {
			return err
		}
		for g, l := range nf.Groups {
			if l == permission.Deny {
				continue
			}
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO folder_group_grant (folder_id, group_name, level) VALUES (?, ?, ?)`), f.ID, g, l.String()); err != nil {
				return err
			}
		}
		if nf.Event != nil {
			nf.Event.NoteID = f.ID
		}
		return s.insertEvent(ctx, tx, nf.Event)
	})
	if err != nil {
		return nil, err
	}
	return f, nil
}

func (s *Store) FolderByID(ctx context.Context, id string) (*Folder, error) {
	return scanFolder(s.db.QueryRowContext(ctx, s.q(`SELECT `+folderColumns+` FROM folder f WHERE f.id = ?`), id))
}

func (s *Store) RenameFolder(ctx context.Context, id, name string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, s.q(`UPDATE folder SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`), name, Now(), id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

// FolderChain returns the folder and its ancestors, root first.
func (s *Store) FolderChain(ctx context.Context, id string) ([]Folder, error) {
	return s.folderChain(ctx, s.db, id)
}

func (s *Store) folderChain(ctx context.Context, db execer, id string) ([]Folder, error) {
	rows, err := db.QueryContext(ctx, s.q(`WITH RECURSIVE chain(id, depth) AS (
			SELECT id, 0 FROM folder WHERE id = ?
			UNION ALL SELECT p.parent_id, c.depth + 1 FROM chain c JOIN folder p ON p.id = c.id
			WHERE p.parent_id IS NOT NULL AND c.depth < ?)
		SELECT `+folderColumns+` FROM chain c JOIN folder f ON f.id = c.id ORDER BY c.depth DESC`), id, MaxFolderDepth+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Folder
	for rows.Next() {
		f, err := scanFolder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out, nil
}

// subtreeSQL selects the ids of a folder and every folder below it.
const subtreeSQL = `WITH RECURSIVE sub(id) AS (SELECT id FROM folder WHERE id = ?
	UNION SELECT f.id FROM folder f JOIN sub ON f.parent_id = sub.id) SELECT id FROM sub`

// SubtreeNoteIDs lists the live notes in a folder and its subfolders.
func (s *Store) SubtreeNoteIDs(ctx context.Context, folderID string) ([]string, error) {
	return s.ids(ctx, s.db, `SELECT id FROM note WHERE deleted_at IS NULL AND folder_id IN (`+subtreeSQL+`)`, folderID)
}

func (s *Store) ids(ctx context.Context, db execer, query string, args ...any) ([]string, error) {
	rows, err := db.QueryContext(ctx, s.q(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) checkDestination(ctx context.Context, tx *sql.Tx, folderID, dest string) error {
	if dest == "" {
		return nil
	}
	chain, err := s.folderChain(ctx, tx, dest)
	if err != nil {
		return err
	}
	for _, f := range chain {
		if f.ID == folderID {
			return ErrFolderCycle
		}
	}
	var below int
	if err := tx.QueryRowContext(ctx, s.q(`WITH RECURSIVE sub(id, depth) AS (SELECT id, 0 FROM folder WHERE id = ?
		UNION ALL SELECT f.id, sub.depth + 1 FROM folder f JOIN sub ON f.parent_id = sub.id WHERE sub.depth < ?)
		SELECT MAX(depth) FROM sub`), folderID, MaxFolderDepth+1).Scan(&below); err != nil {
		return err
	}
	if len(chain)+below+1 > MaxFolderDepth {
		return ErrFolderDepth
	}
	return nil
}

// MoveFolder sets a folder's parent. An empty parent moves it to the top level.
func (s *Store) MoveFolder(ctx context.Context, id, parent string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := s.checkDestination(ctx, tx, id, parent); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE folder SET parent_id = ?, updated_at = ? WHERE id = ?`), nullStr(parent), Now(), id); err != nil {
			return err
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

// MoveNote sets a note's folder. An empty folder moves it to the top level.
func (s *Store) MoveNote(ctx context.Context, noteID, folderID string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE note SET folder_id = ? WHERE id = ?`), nullStr(folderID), noteID); err != nil {
			return err
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

type FolderSummary struct {
	ID        string `json:"id"`
	ParentID  string `json:"parent_id,omitempty"`
	Name      string `json:"name"`
	OwnerName string `json:"owner"`
	OwnerID   string `json:"owner_id,omitempty"`
	UpdatedAt string `json:"updated_at"`
	// HasChildren tells a folder tree whether to show an expand arrow.
	HasChildren bool `json:"has_children"`
	// Items counts the folders and documents directly inside.
	Items int `json:"items"`
}

type FolderFilter struct {
	Viewer Viewer
	// Parent lists the children of one folder. The caller checks access to it.
	Parent string
	// Scope is mine or shared, for the top level, when Parent is empty.
	Scope Scope
}

func (s *Store) ListFolders(ctx context.Context, f FolderFilter) ([]FolderSummary, error) {
	where, args := "", []any{}
	switch {
	case f.Parent != "":
		where, args = "f.parent_id = ?", []any{f.Parent}
	case f.Scope == ScopeShared:
		where, args = sharedWhere("folder", "f", f.Viewer)
	case f.Viewer.Local:
		where = "f.parent_id IS NULL"
	default:
		where, args = "f.parent_id IS NULL AND f.owner_id = ?", []any{f.Viewer.UserID}
	}
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT f.id, COALESCE(f.parent_id, ''), f.name, COALESCE(u.display_name, ''), COALESCE(f.owner_id, ''), f.updated_at,
		(SELECT COUNT(*) FROM folder c WHERE c.parent_id = f.id AND c.deleted_at IS NULL),
		(SELECT COUNT(*) FROM note n WHERE n.folder_id = f.id AND n.deleted_at IS NULL)
		FROM folder f LEFT JOIN app_user u ON u.id = f.owner_id
		WHERE f.deleted_at IS NULL AND `+where+` ORDER BY LOWER(f.name), f.id`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FolderSummary{}
	for rows.Next() {
		var fs FolderSummary
		var children, notes int
		if err := rows.Scan(&fs.ID, &fs.ParentID, &fs.Name, &fs.OwnerName, &fs.OwnerID, &fs.UpdatedAt, &children, &notes); err != nil {
			return nil, err
		}
		fs.HasChildren = children > 0
		fs.Items = children + notes
		out = append(out, fs)
	}
	return out, rows.Err()
}

func (s *Store) FolderACL(ctx context.Context, folderID string) (*ACL, error) {
	acl := &ACL{Users: []UserGrant{}, Groups: []GroupGrant{}}
	err := s.db.QueryRowContext(ctx, s.q(`SELECT COALESCE(owner_id, '') FROM folder WHERE id = ?`), folderID).Scan(&acl.OwnerID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return acl, s.loadGrants(ctx, "folder", folderID, acl)
}

func (s *Store) SetFolderUserGrant(ctx context.Context, folderID, userID string, l permission.Level, ev *Event) error {
	return s.setGrant(ctx, "folder", folderID, "user_id", userID, l, ev)
}

func (s *Store) SetFolderGroupGrant(ctx context.Context, folderID, group string, l permission.Level, ev *Event) error {
	return s.setGrant(ctx, "folder", folderID, "group_name", group, l, ev)
}
