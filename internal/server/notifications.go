package server

import (
	"net/http"

	"github.com/greyhavenhq/greydoc/internal/store"
)

// mentionsUser returns the signed-in caller. Mentions and notifications exist only when OIDC is on.
func (s *Server) mentionsUser(w http.ResponseWriter, r *http.Request) (*Identity, bool) {
	if s.cfg.LocalMode() {
		writeError(w, http.StatusNotFound, "not_found", "notifications need sign-in, which local mode does not have")
		return nil, false
	}
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
		return nil, false
	}
	return id, true
}

func (s *Server) handleNotifications(w http.ResponseWriter, r *http.Request) {
	id, ok := s.mentionsUser(w, r)
	if !ok {
		return
	}
	list, err := s.store.Notifications(r.Context(), id.UserID(), 50)
	if err != nil {
		internalError(w, err)
		return
	}
	unread, err := s.store.UnreadNotifications(r.Context(), id.UserID())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"notifications": list, "unread": unread})
}

func (s *Server) handleReadNotifications(w http.ResponseWriter, r *http.Request) {
	id, ok := s.mentionsUser(w, r)
	if !ok {
		return
	}
	var req struct {
		IDs []string `json:"ids"`
		All bool     `json:"all"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.IDs) == 0 && !req.All {
		writeError(w, http.StatusBadRequest, "bad_request", "send ids or all")
		return
	}
	if len(req.IDs) > 200 {
		req.IDs = req.IDs[:200]
	}
	if req.All {
		req.IDs = nil
	}
	if err := s.store.MarkNotificationsRead(r.Context(), id.UserID(), req.IDs); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleUserNames maps usernames to current display names, for mention chips.
func (s *Server) handleUserNames(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.mentionsUser(w, r); !ok {
		return
	}
	names := r.URL.Query()["u"]
	if len(names) > 100 {
		names = names[:100]
	}
	users, err := s.store.UsersByUsername(r.Context(), names)
	if err != nil {
		internalError(w, err)
		return
	}
	out := map[string]string{}
	for _, u := range users {
		out[u.Username] = displayName(u)
	}
	writeJSON(w, http.StatusOK, map[string]any{"names": out})
}

func displayName(u store.User) string {
	if u.DisplayName != "" {
		return u.DisplayName
	}
	return u.Username
}
