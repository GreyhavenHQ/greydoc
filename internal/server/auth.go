package server

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/greyhavenhq/greydoc/internal/secrets"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// Identity is the caller of a request. A nil *Identity is an anonymous guest.
type Identity struct {
	User *store.User
	// Local is true in local mode, where every request has full access.
	Local bool
	// Via is how the caller authenticated: local, session, token or oauth.
	Via string
	// Client names the MCP or API client for token and oauth callers.
	Client string
}

func (id *Identity) UserID() string {
	if id == nil || id.User == nil {
		return ""
	}
	return id.User.ID
}

type ctxKey int

const identityKey ctxKey = 1

func identityFrom(ctx context.Context) *Identity {
	id, _ := ctx.Value(identityKey).(*Identity)
	return id
}

// withIdentity resolves the caller once per request. A bad credential is an error, not a guest.
func (s *Server) withIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := s.identify(r)
		if err != nil {
			w.Header().Set("WWW-Authenticate", s.wwwAuthenticate(r))
			writeError(w, http.StatusUnauthorized, "invalid_token", err.Error())
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey, id)))
	})
}

var errInvalidToken = errors.New("the access token is invalid or expired")

func (s *Server) identify(r *http.Request) (*Identity, error) {
	if s.cfg.LocalMode() {
		return &Identity{User: s.localUser, Local: true, Via: "local"}, nil
	}
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return s.identifyBearer(r.Context(), strings.TrimSpace(auth[len("Bearer "):]))
	}
	if c, err := r.Cookie(sessionCookieName); err == nil && c.Value != "" {
		u, err := s.store.UserBySessionHash(r.Context(), secrets.Hash(s.secret, c.Value))
		if err == nil {
			return &Identity{User: u, Via: "session"}, nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
	}
	return nil, nil
}

func (s *Server) identifyBearer(ctx context.Context, token string) (*Identity, error) {
	return nil, errInvalidToken
}

func (s *Server) wwwAuthenticate(r *http.Request) string {
	return `Bearer realm="greydoc"`
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	view := map[string]any{
		"authenticated": id != nil,
		"local_mode":    s.cfg.LocalMode(),
		"ai_enabled":    s.cfg.AIEnabled(),
		"login_url":     "/auth/login",
	}
	if id != nil {
		view["id"] = id.User.ID
		view["username"] = id.User.Username
		view["display_name"] = id.User.DisplayName
		view["groups"] = id.User.Groups
	}
	writeJSON(w, http.StatusOK, view)
}
