package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/greyhavenhq/greydoc/internal/collab"
	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// Close codes for a note that cannot be opened. They tell the client to stop reconnecting.
const (
	wsSignIn    = 4401
	wsForbidden = 4403
	wsNotFound  = 4404
	wsInTrash   = 4410
)

// refuseWebsocket accepts the connection and closes it with a reason. A failed handshake looks like a network
// error to the browser: the client retries forever, and Firefox slows down every later connection to this server.
func (s *Server) refuseWebsocket(w http.ResponseWriter, r *http.Request, code websocket.StatusCode, reason string) {
	u, err := url.Parse(s.baseURL(r))
	if err != nil {
		internalError(w, err)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{u.Host}})
	if err != nil {
		return
	}
	_ = ws.Close(code, reason)
}

func isWebsocket(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

// handleWS upgrades /ws/{alias} to a y-websocket session. Access is checked before the upgrade.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	if origin := r.Header.Get("Origin"); origin != "" && origin != s.baseURL(r) {
		writeError(w, http.StatusForbidden, "cross_origin", "cross-origin websocket refused")
		return
	}
	n, err := s.store.NoteByAlias(r.Context(), r.PathValue("alias"))
	if errors.Is(err, store.ErrNotFound) {
		s.refuseWebsocket(w, r, wsNotFound, "this document does not exist")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	if n.DeletedAt != "" {
		s.refuseWebsocket(w, r, wsInTrash, "this document is in the trash")
		return
	}
	level, err := s.noteLevel(r.Context(), identityFrom(r.Context()), n, shareToken(r))
	if err != nil {
		internalError(w, err)
		return
	}
	if level < permission.Read {
		if identityFrom(r.Context()) == nil {
			s.refuseWebsocket(w, r, wsSignIn, "sign in to open this document")
		} else {
			s.refuseWebsocket(w, r, wsForbidden, "you do not have access to this document")
		}
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
	if d := time.Since(start); d > time.Second {
		slog.Warn("slow websocket handshake", "note", n.ID, "took", d)
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
			fresh, err := s.withFreshGroups(ctx, id)
			if err != nil {
				return permission.Deny, err
			}
			return s.noteLevel(ctx, fresh, cur, token)
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
