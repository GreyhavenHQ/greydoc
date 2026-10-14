package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/secrets"
)

const (
	GroupEveryone = "_everyone"
	GroupSignedIn = "_signed_in"
)

type UserGrant struct {
	UserID      string           `json:"user_id"`
	Username    string           `json:"username"`
	DisplayName string           `json:"display_name"`
	Level       permission.Level `json:"level"`
}

type GroupGrant struct {
	Group string           `json:"group"`
	Level permission.Level `json:"level"`
}

type ACL struct {
	OwnerID string       `json:"owner_id"`
	Users   []UserGrant  `json:"users"`
	Groups  []GroupGrant `json:"groups"`
}

func (s *Store) NoteACL(ctx context.Context, noteID string) (*ACL, error) {
	acl := &ACL{Users: []UserGrant{}, Groups: []GroupGrant{}}
	err := s.db.QueryRowContext(ctx, s.q(`SELECT COALESCE(owner_id, '') FROM note WHERE id = ?`), noteID).Scan(&acl.OwnerID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT g.user_id, u.username, u.display_name, g.level
		FROM note_user_grant g JOIN app_user u ON u.id = g.user_id WHERE g.note_id = ? ORDER BY u.username`), noteID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var g UserGrant
		var lvl string
		if err := rows.Scan(&g.UserID, &g.Username, &g.DisplayName, &lvl); err != nil {
			rows.Close()
			return nil, err
		}
		g.Level, _ = permission.ParseLevel(lvl)
		acl.Users = append(acl.Users, g)
	}
	rows.Close()
	rows, err = s.db.QueryContext(ctx, s.q(`SELECT group_name, level FROM note_group_grant WHERE note_id = ? ORDER BY group_name`), noteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var g GroupGrant
		var lvl string
		if err := rows.Scan(&g.Group, &lvl); err != nil {
			return nil, err
		}
		g.Level, _ = permission.ParseLevel(lvl)
		acl.Groups = append(acl.Groups, g)
	}
	return acl, rows.Err()
}

// SetUserGrant sets or, with Deny, removes a user grant.
func (s *Store) SetUserGrant(ctx context.Context, noteID, userID string, l permission.Level, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`DELETE FROM note_user_grant WHERE note_id = ? AND user_id = ?`), noteID, userID); err != nil {
			return err
		}
		if l > permission.Deny {
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO note_user_grant (note_id, user_id, level) VALUES (?, ?, ?)`),
				noteID, userID, l.String()); err != nil {
				return err
			}
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

func (s *Store) SetGroupGrant(ctx context.Context, noteID, group string, l permission.Level, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`DELETE FROM note_group_grant WHERE note_id = ? AND group_name = ?`), noteID, group); err != nil {
			return err
		}
		if l > permission.Deny {
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO note_group_grant (note_id, group_name, level) VALUES (?, ?, ?)`),
				noteID, group, l.String()); err != nil {
				return err
			}
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

func (s *Store) SetOwner(ctx context.Context, noteID, userID string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE note SET owner_id = ? WHERE id = ?`), userID, noteID); err != nil {
			return err
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

func (s *Store) SetAgentPolicyWithEvent(ctx context.Context, noteID string, p AgentPolicy, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE note SET agent_policy = ? WHERE id = ?`), string(p), noteID); err != nil {
			return err
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

type ShareLink struct {
	ID        string `json:"id"`
	NoteID    string `json:"-"`
	Token     string `json:"token"`
	Label     string `json:"label"`
	CreatedAt string `json:"created_at"`
}

func (s *Store) CreateShareLink(ctx context.Context, noteID, label, createdBy string, ev *Event) (*ShareLink, error) {
	l := &ShareLink{ID: secrets.NewID(), NoteID: noteID, Token: secrets.NewToken("")[:32], Label: label, CreatedAt: Now()}
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO share_link (id, note_id, token, label, created_by, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`), l.ID, noteID, l.Token, label, nullStr(createdBy), l.CreatedAt); err != nil {
			return err
		}
		return s.insertEvent(ctx, tx, ev)
	})
	return l, err
}

func (s *Store) ShareLinks(ctx context.Context, noteID string) ([]ShareLink, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT id, token, label, created_at FROM share_link WHERE note_id = ? ORDER BY created_at`), noteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ShareLink{}
	for rows.Next() {
		l := ShareLink{NoteID: noteID}
		if err := rows.Scan(&l.ID, &l.Token, &l.Label, &l.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (s *Store) DeleteShareLink(ctx context.Context, noteID, id string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, s.q(`DELETE FROM share_link WHERE id = ? AND note_id = ?`), id, noteID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

func (s *Store) ShareLinkValid(ctx context.Context, noteID, token string) (bool, error) {
	if token == "" {
		return false, nil
	}
	var n int
	err := s.db.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM share_link WHERE note_id = ? AND token = ?`), noteID, token).Scan(&n)
	return n > 0, err
}
