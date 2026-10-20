package store

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"

	"github.com/greyhavenhq/greydoc/internal/secrets"
)

// LocalUserID is the single identity used in local mode.
const LocalUserID = "local"

type User struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email,omitempty"`
	// Groups only set the admin flag. They are not shown to other people.
	Groups []string `json:"-"`
	// GroupIDs are the greydoc groups of the user. They give document access.
	GroupIDs []string `json:"-"`
}

func (s *Store) EnsureLocalUser(ctx context.Context) (*User, error) {
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO app_user (id, username, display_name, created_at)
		VALUES (?, 'local', 'Local user', ?) ON CONFLICT (id) DO NOTHING`), LocalUserID, Now())
	if err != nil {
		return nil, err
	}
	return s.UserByID(ctx, LocalUserID)
}

// UpsertOIDCUser creates the user on first login, refreshes profile and replaces groups.
func (s *Store) UpsertOIDCUser(ctx context.Context, sub, username, displayName, email string, groups []string) (*User, error) {
	var id string
	err := s.tx(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, s.q(`SELECT id FROM app_user WHERE sub = ?`), sub).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			id = secrets.NewID()
			name, err := s.freeUsername(ctx, tx, username)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO app_user (id, sub, username, display_name, email, created_at, last_login_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)`), id, sub, name, displayName, email, Now(), Now()); err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else if _, err := tx.ExecContext(ctx, s.q(`UPDATE app_user SET display_name = ?, email = ?, last_login_at = ? WHERE id = ?`),
			displayName, email, Now(), id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`DELETE FROM user_group WHERE user_id = ?`), id); err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, g := range groups {
			if seen[g] {
				continue
			}
			seen[g] = true
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO user_group (user_id, group_name) VALUES (?, ?)`), id, g); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.UserByID(ctx, id)
}

func (s *Store) freeUsername(ctx context.Context, tx *sql.Tx, want string) (string, error) {
	base := strings.ToLower(strings.TrimSpace(want))
	if base == "" || base == "local" {
		base = "user"
	}
	name := base
	for i := 2; ; i++ {
		var n int
		if err := tx.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM app_user WHERE username = ?`), name).Scan(&n); err != nil {
			return "", err
		}
		if n == 0 {
			return name, nil
		}
		name = base + "-" + strconv.Itoa(i)
	}
}

func (s *Store) UserByID(ctx context.Context, id string) (*User, error) {
	var u User
	err := s.db.QueryRowContext(ctx, s.q(`SELECT id, username, display_name, email FROM app_user WHERE id = ?`), id).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if u.Groups, err = s.userGroups(ctx, id); err != nil {
		return nil, err
	}
	u.GroupIDs, err = s.UserGroupIDs(ctx, id)
	return &u, err
}

func (s *Store) UserByUsername(ctx context.Context, username string) (*User, error) {
	var id string
	err := s.db.QueryRowContext(ctx, s.q(`SELECT id FROM app_user WHERE username = ?`), strings.ToLower(username)).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.UserByID(ctx, id)
}

func (s *Store) userGroups(ctx context.Context, id string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT group_name FROM user_group WHERE user_id = ? ORDER BY group_name`), id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var g string
		if err := rows.Scan(&g); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// SearchUsers matches username or display name, for the share dialog.
func (s *Store) SearchUsers(ctx context.Context, q string, limit int) ([]User, error) {
	like := "%" + strings.ToLower(q) + "%"
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT id, username, display_name FROM app_user
		WHERE id <> ? AND (LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?) ORDER BY username LIMIT ?`),
		LocalUserID, like, like, limit)
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

// UsersByUsername returns the known users among the given usernames, with their groups.
func (s *Store) UsersByUsername(ctx context.Context, usernames []string) ([]User, error) {
	out := []User{}
	seen := map[string]bool{}
	for _, name := range usernames {
		name = strings.ToLower(name)
		if seen[name] {
			continue
		}
		seen[name] = true
		u, err := s.UserByUsername(ctx, name)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}
	return out, nil
}
