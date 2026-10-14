package server

import (
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/coder/websocket"

	"github.com/greyhavenhq/greydoc/internal/collab"
	"github.com/greyhavenhq/greydoc/internal/permission"
)

// handleWS upgrades /ws/{alias} to a y-websocket session. Access is checked before the upgrade.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != s.baseURL(r) {
		writeError(w, http.StatusForbidden, "cross_origin", "cross-origin websocket refused")
		return
	}
	u, err := url.Parse(s.baseURL(r))
	if err != nil {
		internalError(w, err)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{u.Host}})
	if err != nil {
		slog.Debug("websocket accept failed", "error", err)
		return
	}
	id := identityFrom(r.Context())
	token := shareToken(r)
	noteID := n.ID
	peer := collab.Peer{UserID: id.UserID(), Name: id.displayName(),
		Authorize: func(ctx context.Context) (permission.Level, error) {
			cur, err := s.store.NoteByID(ctx, noteID)
			if err != nil {
				return permission.Deny, nil
			}
			return s.noteLevel(ctx, id, cur, token)
		},
	}
	if id != nil && id.Local {
		peer.TrustClientName = true
		if name := strings.TrimSpace(r.URL.Query().Get("name")); name != "" && len(name) <= 64 {
			peer.Name = name
		}
	}
	// The request context ends when the handler returns. The session must outlive nothing else.
	s.hub.Serve(context.WithoutCancel(r.Context()), ws, n.ID, peer)
}
