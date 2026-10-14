package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/greyhavenhq/greydoc/internal/secrets"
	"github.com/greyhavenhq/greydoc/internal/store"
)

const (
	patPrefix     = "gd_pat_"
	accessPrefix  = "gd_at_"
	refreshPrefix = "gd_rt_"

	scopeRead  = "notes:read"
	scopeWrite = "notes:write"

	accessTTL  = time.Hour
	refreshTTL = 30 * 24 * time.Hour
)

var allScopes = []string{scopeRead, scopeWrite}

func (id *Identity) canWriteScope() bool {
	return id == nil || id.Scopes == nil || slices.Contains(id.Scopes, scopeWrite)
}

func (s *Server) identifyBearer(ctx context.Context, token string) (*Identity, error) {
	kind, via := "", ""
	switch {
	case strings.HasPrefix(token, patPrefix):
		kind, via = store.TokenPAT, "token"
	case strings.HasPrefix(token, accessPrefix):
		kind, via = store.TokenAccess, "oauth"
	default:
		return nil, errInvalidToken
	}
	t, err := s.store.TokenByHash(ctx, kind, secrets.Hash(s.secret, token))
	if errors.Is(err, store.ErrNotFound) {
		return nil, errInvalidToken
	}
	if err != nil {
		return nil, err
	}
	u, err := s.store.UserByID(ctx, t.UserID)
	if err != nil {
		return nil, errInvalidToken
	}
	id := &Identity{User: u, Via: via, Client: t.Label, Scopes: strings.Fields(t.Scope), tokenExpiry: store.ParseTime(t.ExpiresAt)}
	if t.ClientName != "" {
		id.Client = t.ClientName
	}
	if len(id.Scopes) == 0 {
		id.Scopes = allScopes
	}
	return id, nil
}

func (s *Server) wwwAuthenticate(r *http.Request) string {
	return `Bearer realm="greydoc", resource_metadata="` + s.baseURL(r) + `/.well-known/oauth-protected-resource/mcp"`
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
		return
	}
	toks, err := s.store.UserTokens(r.Context(), id.UserID())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": toks, "mcp_url": s.baseURL(r) + "/mcp"})
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil || id.isAgent() {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in with a browser to create tokens")
		return
	}
	var req struct {
		Label string `json:"label"`
		Scope string `json:"scope"`
	}
	if r.ContentLength != 0 && !readJSON(w, r, &req) {
		return
	}
	tok, t, err := s.createPAT(r.Context(), id.UserID(), req.Label, req.Scope)
	if err != nil {
		internalError(w, err)
		return
	}
	_ = s.store.AddEvent(r.Context(), id.event("", "token.create", map[string]any{"label": t.Label, "scope": t.Scope}))
	writeJSON(w, http.StatusCreated, map[string]any{"token": tok, "info": t})
}

func (s *Server) createPAT(ctx context.Context, userID, label, scope string) (string, *store.Token, error) {
	return mintPAT(ctx, s.store, s.secret, userID, label, scope)
}

func mintPAT(ctx context.Context, st *store.Store, secret []byte, userID, label, scope string) (string, *store.Token, error) {
	if strings.TrimSpace(label) == "" {
		label = "personal token"
	}
	if scope != scopeRead {
		scope = scopeRead + " " + scopeWrite
	}
	tok := secrets.NewToken(patPrefix)
	t := &store.Token{UserID: userID, Kind: store.TokenPAT, Label: label, Scope: scope}
	return tok, t, st.CreateToken(ctx, t, secrets.Hash(secret, tok))
}

// MintPAT creates a personal access token for a username, for the CLI. It does not need a running server.
func MintPAT(ctx context.Context, st *store.Store, secret []byte, username, label, scope string) (string, error) {
	if username == store.LocalUserID {
		if _, err := st.EnsureLocalUser(ctx); err != nil {
			return "", err
		}
	}
	u, err := st.UserByUsername(ctx, username)
	if err != nil {
		return "", fmt.Errorf("user %q: %w", username, err)
	}
	tok, _, err := mintPAT(ctx, st, secret, u.ID, label, scope)
	return tok, err
}

func (s *Server) handleDeleteToken(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
		return
	}
	if err := s.store.DeleteToken(r.Context(), id.UserID(), r.PathValue("id")); err != nil {
		s.writeNoteError(w, err)
		return
	}
	_ = s.store.AddEvent(r.Context(), id.event("", "token.revoke", map[string]any{"token": r.PathValue("id")}))
	w.WriteHeader(http.StatusNoContent)
}
