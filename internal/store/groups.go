package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/greyhavenhq/greydoc/internal/secrets"
)

var (
	ErrGroupNameTaken = errors.New("a group with this name exists")
	ErrGroupLinkTaken = errors.New("another group is linked to this OIDC group")
	ErrGroupKind      = errors.New("a group cannot switch between greydoc and OIDC membership")
	ErrGroupLinked    = errors.New("members of a linked group come from the identity provider")
)

// Group is a set of users that can receive document access.
// OIDCGroup empty means admins manage the members in greydoc.
type Group struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	OIDCGroup   string `json:"oidc_group"`
	CreatedAt   string `json:"created_at"`
	MemberCount int    `json:"member_count"`
	NoteCount   int    `json:"note_count"`
}

const groupColumns = `g.id, g.name, g.description, COALESCE(g.oidc_group, ''), g.created_at,
	CASE WHEN g.oidc_group IS NULL THEN (SELECT COUNT(*) FROM app_group_member m WHERE m.group_id = g.id)
	ELSE (SELECT COUNT(*) FROM user_group ug WHERE ug.group_name = g.oidc_group) END,
	(SELECT COUNT(*) FROM note_group_grant gg WHERE gg.group_name = g.id)`

func scanGroup(row interface{ Scan(...any) error }) (*Group, error) {
	var g Group
	err := row.Scan(&g.ID, &g.Name, &g.Description, &g.OIDCGroup, &g.CreatedAt, &g.MemberCount, &g.NoteCount)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &g, err
}

func (s *Store) Groups(ctx context.Context) ([]Group, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+groupColumns+` FROM app_group g ORDER BY LOWER(g.name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Group{}
	for rows.Next() {
		g, err := scanGroup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *g)
	}
	return out, rows.Err()
}

func (s *Store) GroupByID(ctx context.Context, id string) (*Group, error) {
	return scanGroup(s.db.QueryRowContext(ctx, s.q(`SELECT `+groupColumns+` FROM app_group g WHERE g.id = ?`), id))
}

// GroupByName ignores case.
func (s *Store) GroupByName(ctx context.Context, name string) (*Group, error) {
	return scanGroup(s.db.QueryRowContext(ctx, s.q(`SELECT `+groupColumns+` FROM app_group g WHERE LOWER(g.name) = LOWER(?)`), name))
}

func (s *Store) checkGroupUnique(ctx context.Context, tx *sql.Tx, id, name, oidcGroup string) error {
	var n int
	if err := tx.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM app_group WHERE LOWER(name) = LOWER(?) AND id <> ?`), name, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return ErrGroupNameTaken
	}
	if oidcGroup == "" {
		return nil
	}
	if err := tx.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM app_group WHERE oidc_group = ? AND id <> ?`), oidcGroup, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return ErrGroupLinkTaken
	}
	return nil
}

func (s *Store) CreateGroup(ctx context.Context, name, description, oidcGroup string, ev *Event) (*Group, error) {
	id := secrets.NewID()
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := s.checkGroupUnique(ctx, tx, id, name, oidcGroup); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO app_group (id, name, description, oidc_group, created_at) VALUES (?, ?, ?, ?, ?)`),
			id, name, description, nullStr(oidcGroup), Now()); err != nil {
			return err
		}
		if ev != nil {
			if ev.Data == nil {
				ev.Data = map[string]any{}
			}
			ev.Data["id"] = id
		}
		return s.insertEvent(ctx, tx, ev)
	})
	if err != nil {
		return nil, err
	}
	return s.GroupByID(ctx, id)
}

// UpdateGroup sets name, description and the OIDC link. The link cannot be added or removed.
func (s *Store) UpdateGroup(ctx context.Context, id, name, description, oidcGroup string, ev *Event) (*Group, error) {
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var cur string
		err := tx.QueryRowContext(ctx, s.q(`SELECT COALESCE(oidc_group, '') FROM app_group WHERE id = ?`), id).Scan(&cur)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if (cur == "") != (oidcGroup == "") {
			return ErrGroupKind
		}
		if err := s.checkGroupUnique(ctx, tx, id, name, oidcGroup); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE app_group SET name = ?, description = ?, oidc_group = ? WHERE id = ?`),
			name, description, nullStr(oidcGroup), id); err != nil {
			return err
		}
		return s.insertEvent(ctx, tx, ev)
	})
	if err != nil {
		return nil, err
	}
	return s.GroupByID(ctx, id)
}

// DeleteGroup removes the group, its members and its grants. It returns the notes that lost a grant.
func (s *Store) DeleteGroup(ctx context.Context, id string, ev *Event) ([]string, error) {
	var noteIDs []string
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		if noteIDs, err = s.groupNoteIDs(ctx, tx, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`DELETE FROM note_group_grant WHERE group_name = ?`), id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`DELETE FROM app_group_member WHERE group_id = ?`), id); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, s.q(`DELETE FROM app_group WHERE id = ?`), id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return s.insertEvent(ctx, tx, ev)
	})
	return noteIDs, err
}

// GroupNoteIDs lists the notes that grant the group a level.
func (s *Store) GroupNoteIDs(ctx context.Context, id string) ([]string, error) {
	return s.groupNoteIDs(ctx, s.db, id)
}

func (s *Store) groupNoteIDs(ctx context.Context, db execer, id string) ([]string, error) {
	rows, err := db.QueryContext(ctx, s.q(`SELECT note_id FROM note_group_grant WHERE group_name = ? ORDER BY note_id`), id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// GroupMembers lists the members. For a linked group, they are the users with the OIDC group at their last sign-in.
func (s *Store) GroupMembers(ctx context.Context, g *Group) ([]User, error) {
	query, arg := `SELECT u.id, u.username, u.display_name FROM app_group_member m JOIN app_user u ON u.id = m.user_id
		WHERE m.group_id = ? ORDER BY u.username`, g.ID
	if g.OIDCGroup != "" {
		query, arg = `SELECT u.id, u.username, u.display_name FROM user_group ug JOIN app_user u ON u.id = ug.user_id
			WHERE ug.group_name = ? ORDER BY u.username`, g.OIDCGroup
	}
	rows, err := s.db.QueryContext(ctx, s.q(query), arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) AddGroupMember(ctx context.Context, groupID, userID string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var link string
		err := tx.QueryRowContext(ctx, s.q(`SELECT COALESCE(oidc_group, '') FROM app_group WHERE id = ?`), groupID).Scan(&link)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if link != "" {
			return ErrGroupLinked
		}
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO app_group_member (group_id, user_id, added_at) VALUES (?, ?, ?)
			ON CONFLICT (group_id, user_id) DO NOTHING`), groupID, userID, Now()); err != nil {
			return err
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

func (s *Store) RemoveGroupMember(ctx context.Context, groupID, userID string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, s.q(`DELETE FROM app_group_member WHERE group_id = ? AND user_id = ?`), groupID, userID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

// UserGroupIDs lists the groups of a user: greydoc memberships and groups linked to the user's OIDC groups.
func (s *Store) UserGroupIDs(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT group_id FROM app_group_member WHERE user_id = ?
		UNION SELECT g.id FROM app_group g JOIN user_group ug ON ug.group_name = g.oidc_group WHERE ug.user_id = ?`), userID, userID)
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
