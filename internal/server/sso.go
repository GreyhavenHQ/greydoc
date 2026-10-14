package server

import (
	"crypto/subtle"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/greyhavenhq/greydoc/internal/secrets"
)

// safeNext keeps post-login redirects on this site.
func safeNext(next string) string {
	if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.HasPrefix(next, "/\\") {
		return "/"
	}
	return next
}

func (s *Server) baseURL(r *http.Request) string {
	if s.cfg.BaseURL != "" {
		return s.cfg.BaseURL
	}
	scheme := "http"
	if requestIsHTTPS(r) {
		scheme = "https"
	}
	host := r.Host
	if fh := r.Header.Get("X-Forwarded-Host"); fh != "" {
		host = fh
	}
	return scheme + "://" + host
}

func (s *Server) redirectURL(r *http.Request) string {
	if s.cfg.OIDCRedirectURL != "" {
		return s.cfg.OIDCRedirectURL
	}
	return s.baseURL(r) + "/auth/callback"
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	next := safeNext(r.URL.Query().Get("next"))
	if s.sso == nil {
		http.Redirect(w, r, next, http.StatusFound)
		return
	}
	state := secrets.NewID()
	s.setCookie(w, r, stateCookieName, s.makeToken(state+" "+next, 10*time.Minute), 10*time.Minute)
	http.Redirect(w, r, s.sso.AuthCodeURL(state, s.redirectURL(r)), http.StatusFound)
}

func (s *Server) handleAuthCallback(w http.ResponseWriter, r *http.Request) {
	if s.sso == nil {
		writeError(w, http.StatusNotFound, "sso_not_configured", "OIDC is not configured")
		return
	}
	if e := r.URL.Query().Get("error"); e != "" {
		writeError(w, http.StatusBadRequest, "sso_denied", "the identity provider reported: "+e)
		return
	}
	var expected, next string
	if c, err := r.Cookie(stateCookieName); err == nil {
		if v, ok := s.verifyToken(c.Value); ok {
			expected, next, _ = strings.Cut(v, " ")
		}
	}
	received := r.URL.Query().Get("state")
	if expected == "" || subtle.ConstantTimeCompare([]byte(expected), []byte(received)) != 1 {
		writeError(w, http.StatusBadRequest, "sso_state_mismatch", "login state did not match; start again from /auth/login")
		return
	}
	accessToken, err := s.sso.Exchange(r.Context(), r.URL.Query().Get("code"), s.redirectURL(r))
	if err != nil {
		slog.Error("oidc code exchange failed", "error", err)
		writeError(w, http.StatusBadGateway, "sso_exchange_failed", "could not exchange the authorization code")
		return
	}
	ident, err := s.sso.Userinfo(r.Context(), accessToken)
	if err != nil {
		slog.Error("oidc userinfo failed", "error", err)
		writeError(w, http.StatusBadGateway, "sso_userinfo_failed", "could not fetch identity from the provider")
		return
	}
	user, err := s.store.UpsertOIDCUser(r.Context(), ident.Sub, ident.Username, ident.DisplayName, ident.Email, ident.Groups)
	if err != nil {
		slog.Error("user upsert failed", "error", err)
		writeError(w, http.StatusInternalServerError, "internal", "failed to provision your account")
		return
	}
	s.clearCookie(w, r, stateCookieName)
	if err := s.issueSession(w, r, user.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "failed to create your session")
		return
	}
	http.Redirect(w, r, safeNext(next), http.StatusSeeOther)
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookieName); err == nil && c.Value != "" {
		if err := s.store.DeleteSessionByHash(r.Context(), secrets.Hash(s.secret, c.Value)); err != nil {
			slog.Warn("failed to delete session on logout", "error", err)
		}
	}
	s.clearCookie(w, r, sessionCookieName)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}
