package server

import (
	"net/http"
	"slices"
)

// prefValues lists the editor preferences and their allowed values.
var prefValues = map[string][]string{
	"default_mode": {"live", "editor", "split", "preview"},
	"live_style":   {"document", "obsidian"},
}

// handleSetPrefs merges the given preferences into the stored ones. An empty value removes the key.
func (s *Server) handleSetPrefs(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
		return
	}
	var req map[string]string
	if !readJSON(w, r, &req) {
		return
	}
	u, err := s.store.UserByID(r.Context(), id.UserID())
	if err != nil {
		internalError(w, err)
		return
	}
	prefs := u.Prefs
	if prefs == nil {
		prefs = map[string]string{}
	}
	for k, v := range req {
		allowed, ok := prefValues[k]
		if !ok {
			writeError(w, http.StatusBadRequest, "bad_request", "unknown preference "+k)
			return
		}
		if v == "" {
			delete(prefs, k)
			continue
		}
		if !slices.Contains(allowed, v) {
			writeError(w, http.StatusBadRequest, "bad_request", "invalid value for "+k)
			return
		}
		prefs[k] = v
	}
	if err := s.store.SetUserPrefs(r.Context(), u.ID, prefs); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"prefs": prefs})
}
