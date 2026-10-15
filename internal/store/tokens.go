package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/greyhavenhq/greydoc/internal/secrets"
)

const (
	TokenPAT     = "pat"
	TokenAccess  = "access"
	TokenRefresh = "refresh"
)

type Token struct {
	ID         string `json:"id"`
	UserID     string `json:"user_id"`
	Kind       string `json:"kind"`
	Label      string `json:"label"`
	ClientID   string `json:"client_id,omitempty"`
	ClientName string `json:"client_name,omitempty"`
	Scope      string `json:"scope"`
	Family     string `json:"-"`
	CreatedAt  string `json:"created_at"`
	ExpiresAt  string `json:"expires_at,omitempty"`
	LastUsedAt string `json:"last_used_at,omitempty"`
}

func (s *Store) CreateToken(ctx context.Context, t *Token, hash string) error {
	if t.ID == "" {
		t.ID = secrets.NewID()
	}
	t.CreatedAt = Now()
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO api_token (id, user_id, kind, token_hash, label, client_id, scope, family, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`), t.ID, t.UserID, t.Kind, hash, t.Label, t.ClientID, t.Scope, t.Family, t.CreatedAt, nullStr(t.ExpiresAt))
	return err
}

const tokenColumns = `t.id, t.user_id, t.kind, t.label, t.client_id, COALESCE(c.name, ''), t.scope, t.family, t.created_at,
	COALESCE(t.expires_at, ''), COALESCE(t.last_used_at, '')`

func scanToken(sc interface{ Scan(...any) error }) (*Token, error) {
	var t Token
	err := sc.Scan(&t.ID, &t.UserID, &t.Kind, &t.Label, &t.ClientID, &t.ClientName, &t.Scope, &t.Family, &t.CreatedAt, &t.ExpiresAt, &t.LastUsedAt)
	return &t, err
}

// TokenByHash returns a live token of the given kind, or ErrNotFound.
func (s *Store) TokenByHash(ctx context.Context, kind, hash string) (*Token, error) {
	t, err := scanToken(s.db.QueryRowContext(ctx, s.q(`SELECT `+tokenColumns+` FROM api_token t LEFT JOIN oauth_client c ON c.id = t.client_id
		WHERE t.token_hash = ? AND t.kind = ? AND (t.expires_at IS NULL OR t.expires_at > ?)`), hash, kind, Now()))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	_, _ = s.db.ExecContext(ctx, s.q(`UPDATE api_token SET last_used_at = ? WHERE id = ?`), Now(), t.ID)
	return t, nil
}

// UserTokens lists a user's personal tokens and connected OAuth clients (one row per refresh token).
func (s *Store) UserTokens(ctx context.Context, userID string) ([]Token, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT `+tokenColumns+` FROM api_token t LEFT JOIN oauth_client c ON c.id = t.client_id
		WHERE t.user_id = ? AND t.kind IN ('pat', 'refresh') AND (t.expires_at IS NULL OR t.expires_at > ?) ORDER BY t.created_at DESC`), userID, Now())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Token{}
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// DeleteToken revokes a token and, for OAuth, every token of its family.
func (s *Store) DeleteToken(ctx context.Context, userID, id string) error {
	var family string
	err := s.db.QueryRowContext(ctx, s.q(`SELECT family FROM api_token WHERE id = ? AND user_id = ?`), id, userID).Scan(&family)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if family != "" {
		_, err = s.db.ExecContext(ctx, s.q(`DELETE FROM api_token WHERE family = ?`), family)
	} else {
		_, err = s.db.ExecContext(ctx, s.q(`DELETE FROM api_token WHERE id = ?`), id)
	}
	return err
}

func (s *Store) DeleteTokenByHash(ctx context.Context, hash string) error {
	var family string
	err := s.db.QueryRowContext(ctx, s.q(`SELECT family FROM api_token WHERE token_hash = ?`), hash).Scan(&family)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if family != "" {
		_, err = s.db.ExecContext(ctx, s.q(`DELETE FROM api_token WHERE family = ?`), family)
		return err
	}
	_, err = s.db.ExecContext(ctx, s.q(`DELETE FROM api_token WHERE token_hash = ?`), hash)
	return err
}

// RotateRefreshToken returns a live refresh token and expires it. The row stays until the purge,
// so a later reuse of the same token can be recognized and revoke its family.
func (s *Store) RotateRefreshToken(ctx context.Context, hash string) (*Token, error) {
	t, err := s.TokenByHash(ctx, TokenRefresh, hash)
	if err != nil {
		return nil, err
	}
	now := Now()
	res, err := s.db.ExecContext(ctx, s.q(`UPDATE api_token SET expires_at = ?, rotated_at = ? WHERE id = ? AND expires_at > ?`), now, now, t.ID, now)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return t, nil
}

// RotatedRefreshToken returns a refresh token that was rotated after since, or ErrNotFound.
func (s *Store) RotatedRefreshToken(ctx context.Context, hash string, since time.Time) (*Token, error) {
	t, err := scanToken(s.db.QueryRowContext(ctx, s.q(`SELECT `+tokenColumns+` FROM api_token t LEFT JOIN oauth_client c ON c.id = t.client_id
		WHERE t.token_hash = ? AND t.kind = ? AND t.rotated_at <> '' AND t.rotated_at > ?`), hash, TokenRefresh, FormatTime(since)))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return t, err
}

// RevokeFamilyByHash deletes every token of the family a refresh token belongs to, live or expired.
// It reports whether the token was known.
func (s *Store) RevokeFamilyByHash(ctx context.Context, hash string) (bool, error) {
	var family string
	err := s.db.QueryRowContext(ctx, s.q(`SELECT family FROM api_token WHERE token_hash = ? AND kind = ?`), hash, TokenRefresh).Scan(&family)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	_, err = s.db.ExecContext(ctx, s.q(`DELETE FROM api_token WHERE family = ?`), family)
	return true, err
}

// PurgeExpiredTokens deletes tokens and codes that expired more than a day ago. Rotated refresh tokens
// stay for a week, so that a reuse after the reuse grace is still recognized as a leak.
func (s *Store) PurgeExpiredTokens(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, s.q(`DELETE FROM api_token WHERE expires_at IS NOT NULL AND expires_at < ? AND rotated_at < ?`),
		FormatTime(time.Now().Add(-24*time.Hour)), FormatTime(time.Now().Add(-7*24*time.Hour)))
	if err == nil {
		_, err = s.db.ExecContext(ctx, s.q(`DELETE FROM oauth_code WHERE expires_at < ?`), Now())
	}
	if err == nil {
		_, err = s.db.ExecContext(ctx, s.q(`DELETE FROM upload_ticket WHERE expires_at < ?`), Now())
	}
	return err
}

type OAuthClient struct {
	ID           string   `json:"client_id"`
	SecretHash   string   `json:"-"`
	Name         string   `json:"client_name"`
	RedirectURIs []string `json:"redirect_uris"`
	AuthMethod   string   `json:"token_endpoint_auth_method"`
	CreatedAt    string   `json:"-"`
}

func (s *Store) CreateOAuthClient(ctx context.Context, c *OAuthClient) error {
	uris, _ := json.Marshal(c.RedirectURIs)
	c.CreatedAt = Now()
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO oauth_client (id, secret_hash, name, redirect_uris, auth_method, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`), c.ID, c.SecretHash, c.Name, string(uris), c.AuthMethod, c.CreatedAt)
	return err
}

func (s *Store) OAuthClient(ctx context.Context, id string) (*OAuthClient, error) {
	var c OAuthClient
	var uris string
	err := s.db.QueryRowContext(ctx, s.q(`SELECT id, secret_hash, name, redirect_uris, auth_method, created_at FROM oauth_client WHERE id = ?`), id).
		Scan(&c.ID, &c.SecretHash, &c.Name, &uris, &c.AuthMethod, &c.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(uris), &c.RedirectURIs)
	return &c, nil
}

type OAuthCode struct {
	ClientID    string
	UserID      string
	RedirectURI string
	Challenge   string
	Scope       string
	Resource    string
	ExpiresAt   string
}

func (s *Store) CreateOAuthCode(ctx context.Context, hash string, c OAuthCode) error {
	_, err := s.db.ExecContext(ctx, s.q(`INSERT INTO oauth_code (code_hash, client_id, user_id, redirect_uri, challenge, scope, resource, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`), hash, c.ClientID, c.UserID, c.RedirectURI, c.Challenge, c.Scope, c.Resource, c.ExpiresAt)
	return err
}

// ConsumeOAuthCode returns and deletes a live code. A code works once.
func (s *Store) ConsumeOAuthCode(ctx context.Context, hash string) (*OAuthCode, error) {
	var c OAuthCode
	err := s.db.QueryRowContext(ctx, s.q(`SELECT client_id, user_id, redirect_uri, challenge, scope, resource, expires_at FROM oauth_code
		WHERE code_hash = ?`), hash).Scan(&c.ClientID, &c.UserID, &c.RedirectURI, &c.Challenge, &c.Scope, &c.Resource, &c.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	res, err := s.db.ExecContext(ctx, s.q(`DELETE FROM oauth_code WHERE code_hash = ?`), hash)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 || c.ExpiresAt < Now() {
		return nil, ErrNotFound
	}
	return &c, nil
}
