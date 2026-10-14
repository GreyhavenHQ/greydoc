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
func (s *Store) UserBySessionHash(ctx context.Context, tokenHash string) (*User, error) {
	var userID string
	err := s.db.QueryRowContext(ctx, s.q(`SELECT user_id FROM session WHERE token_hash = ? AND expires_at > ?`),
		tokenHash, Now()).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.UserByID(ctx, userID)
}

func (s *Store) DeleteSessionByHash(ctx context.Context, tokenHash string) error {
	_, err := s.db.ExecContext(ctx, s.q(`DELETE FROM session WHERE token_hash = ?`), tokenHash)
	return err
}
