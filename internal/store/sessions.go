package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/greyhavenhq/greydoc/internal/secrets"
)

func (s *Store) CreateSession(ctx context.Context, userID, tokenHash, expiresAt string) error {
	_, _ = s.db.ExecContext(ctx, s.q(`DELETE FROM session WHERE expires_at < ?`), Now())
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO session (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`),
		secrets.NewID(), userID, tokenHash, Now(), expiresAt)
	return err
}

// UserBySessionHash returns the session's user, or ErrNotFound for an unknown or expired session.
// SessionUser returns the user of a live session and when the session ends.
func (s *Store) SessionUser(ctx context.Context, tokenHash string) (*User, string, error) {
	var userID, expires string
	err := s.db.QueryRowContext(ctx, s.q(`SELECT user_id, expires_at FROM session WHERE token_hash = ? AND expires_at > ?`),
		tokenHash, Now()).Scan(&userID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	u, err := s.UserByID(ctx, userID)
	return u, expires, err
}

// ExtendSession moves a live session's end.
func (s *Store) ExtendSession(ctx context.Context, tokenHash, expires string) error {
	_, err := s.db.ExecContext(ctx, s.q(`UPDATE session SET expires_at = ? WHERE token_hash = ? AND expires_at > ?`), expires, tokenHash, Now())
	return err
}

func (s *Store) DeleteSessionByHash(ctx context.Context, tokenHash string) error {
	_, err := s.db.ExecContext(ctx, s.q(`DELETE FROM session WHERE token_hash = ?`), tokenHash)
	return err
}
