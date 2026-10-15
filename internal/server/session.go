package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/greyhavenhq/greydoc/internal/secrets"
	"github.com/greyhavenhq/greydoc/internal/store"
)

const (
	sessionCookieName = "greydoc_session"
	stateCookieName   = "greydoc_oauth_state"
)

func (s *Server) signToken(payload string) string {
	mac := hmac.New(sha256.New, append(append([]byte{}, s.secret...), "/cookies"...))
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

// makeToken signs value with an expiry. The value is base64url so it can hold any byte.
func (s *Server) makeToken(value string, ttl time.Duration) string {
	payload := base64.RawURLEncoding.EncodeToString([]byte(value)) + "." + strconv.FormatInt(time.Now().Add(ttl).Unix(), 10)
	return payload + "." + s.signToken(payload)
}

func (s *Server) verifyToken(token string) (string, bool) {
	last := strings.LastIndexByte(token, '.')
	if last < 0 {
		return "", false
	}
	payload, sig := token[:last], token[last+1:]
	if !hmac.Equal([]byte(s.signToken(payload)), []byte(sig)) {
		return "", false
	}
	enc, expStr, ok := strings.Cut(payload, ".")
	if !ok {
		return "", false
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || time.Now().Unix() >= exp {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil {
		return "", false
	}
	return string(raw), true
}

func requestIsHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	proto, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Proto"), ",")
	return strings.TrimSpace(proto) == "https"
}

func (s *Server) setCookie(w http.ResponseWriter, r *http.Request, name, value string, maxAge time.Duration) {
	seconds := int(maxAge.Seconds())
	if maxAge < 0 {
		seconds = -1
	}
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: value, Path: "/", MaxAge: seconds, HttpOnly: true,
		Secure: requestIsHTTPS(r) || strings.HasPrefix(s.cfg.BaseURL, "https://"),
		// Lax so the cookie survives the top-level redirect back from the IdP.
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) clearCookie(w http.ResponseWriter, r *http.Request, name string) {
	s.setCookie(w, r, name, "", -1)
}

func (s *Server) issueSession(w http.ResponseWriter, r *http.Request, userID string) error {
	token := secrets.NewToken("")
	expires := store.FormatTime(time.Now().Add(s.cfg.SessionTTL))
	if err := s.store.CreateSession(r.Context(), userID, secrets.Hash(s.secret, token), expires); err != nil {
		return err
	}
	s.setCookie(w, r, sessionCookieName, token, s.cfg.SessionTTL)
	return nil
}

// extendSession renews a browser session used past half its lifetime. Only an unused session expires.
func (s *Server) extendSession(w http.ResponseWriter, r *http.Request, id *Identity) {
	if time.Until(id.sessionExpiry) > s.cfg.SessionTTL/2 {
		return
	}
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return
	}
	expires := time.Now().Add(s.cfg.SessionTTL)
	if err := s.store.ExtendSession(r.Context(), secrets.Hash(s.secret, c.Value), store.FormatTime(expires)); err != nil {
		slog.Warn("session renewal failed", "error", err)
		return
	}
	id.sessionExpiry = expires
	s.setCookie(w, r, sessionCookieName, c.Value, s.cfg.SessionTTL)
}
