// Package server is the HTTP layer: JSON API, websocket sync, MCP and the embedded UI.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/greyhavenhq/greydoc/internal/collab"
	"github.com/greyhavenhq/greydoc/internal/config"
	"github.com/greyhavenhq/greydoc/internal/oidc"
	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/secrets"
	"github.com/greyhavenhq/greydoc/internal/store"
)

type Server struct {
	cfg    config.Config
	store  *store.Store
	secret []byte
	mux    *http.ServeMux
	sso    *oidc.Client
	// localUser is the identity of every request in local mode.
	localUser     *store.User
	guestMax      permission.Level
	defaultGroups map[string]permission.Level
	hub           *collab.Hub
	mirror        noteMirror
}

type noteMirror interface {
	Touch(noteID string)
	Remove(noteID string)
}

func Open(cfg config.Config) (*Server, error) {
	secret, err := secrets.LoadOrCreate(cfg.Secret, cfg.SecretFile)
	if err != nil {
		return nil, err
	}
	st, err := store.Open(cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := st.Init(ctx); err != nil {
		st.Close()
		return nil, err
	}
	s := &Server{cfg: cfg, store: st, secret: secret, mux: http.NewServeMux()}
	var ok bool
	if s.guestMax, ok = permission.ParseLevel(cfg.GuestMax); !ok || s.guestMax == permission.Full {
		st.Close()
		return nil, fmt.Errorf("GREYDOC_GUEST_MAX must be deny, read, comment or write")
	}
	everyone, ok1 := permission.ParseLevel(cfg.DefaultEveryone)
	signedIn, ok2 := permission.ParseLevel(cfg.DefaultSignedIn)
	if !ok1 || !ok2 || everyone == permission.Full || signedIn == permission.Full {
		st.Close()
		return nil, fmt.Errorf("GREYDOC_DEFAULT_EVERYONE and GREYDOC_DEFAULT_SIGNED_IN must be deny, read, comment or write")
	}
	s.defaultGroups = map[string]permission.Level{store.GroupEveryone: min(everyone, s.guestMax), store.GroupSignedIn: signedIn}
	if cfg.LocalMode() {
		if s.localUser, err = st.EnsureLocalUser(ctx); err != nil {
			st.Close()
			return nil, err
		}
	} else {
		s.sso, err = oidc.Discover(ctx, oidc.Config{Issuer: cfg.OIDCIssuer, ClientID: cfg.OIDCClientID,
			ClientSecret: cfg.OIDCClientSecret, Scopes: cfg.OIDCScopes, GroupsClaim: cfg.OIDCGroupsClaim})
		if err != nil {
			st.Close()
			return nil, err
		}
	}
	s.hub = collab.NewHub(roomStore{st: st}, collab.Options{IdleGrace: cfg.RoomIdleGrace, SaveInterval: cfg.RoomSaveEvery, OnSaved: s.afterSave})
	s.routes()
	return s, nil
}

func (s *Server) Store() *store.Store { return s.store }

func (s *Server) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	s.hub.Shutdown(ctx)
	return s.store.Close()
}

// afterSave runs when a room stored a snapshot.
func (s *Server) afterSave(noteID string) {
	if s.mirror != nil {
		s.mirror.Touch(noteID)
	}
}

func (s *Server) Handler() http.Handler { return s.checkOrigin(s.withIdentity(s.mux)) }

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	s.mux.HandleFunc("GET /auth/login", s.handleAuthLogin)
	s.mux.HandleFunc("GET /auth/callback", s.handleAuthCallback)
	s.mux.HandleFunc("POST /auth/logout", s.handleAuthLogout)
	s.mux.HandleFunc("GET /api/me", s.handleMe)
	s.mux.HandleFunc("GET /api/users", s.handleSearchUsers)

	s.mux.HandleFunc("GET /api/notes", s.handleListNotes)
	s.mux.HandleFunc("GET /api/tags", s.handleTags)
	s.mux.HandleFunc("POST /api/notes", s.handleCreateNote)
	s.mux.HandleFunc("PUT /api/notes/{alias}/pin", s.handlePin)
	s.mux.HandleFunc("DELETE /api/notes/{alias}/pin", s.handlePin)
	s.mux.HandleFunc("DELETE /api/notes/{alias}/visit", s.handleForgetVisit)
	s.mux.HandleFunc("GET /api/notes/{alias}", s.handleGetNote)
	s.mux.HandleFunc("DELETE /api/notes/{alias}", s.handleDeleteNote)
	s.mux.HandleFunc("GET /api/notes/{alias}/content", s.handleGetNoteContent)
	s.mux.HandleFunc("POST /api/notes/{alias}/aliases", s.handleAliases)
	s.mux.HandleFunc("PUT /api/notes/{alias}/aliases", s.handleAliases)
	s.mux.HandleFunc("DELETE /api/notes/{alias}/aliases/{name}", s.handleAliases)

	s.mux.HandleFunc("GET /ws/{alias}", s.handleWS)

	s.mux.HandleFunc("GET /api/notes/{alias}/permissions", s.handleGetPermissions)
	s.mux.HandleFunc("PUT /api/notes/{alias}/permissions/users/{username}", s.handleUserGrant)
	s.mux.HandleFunc("DELETE /api/notes/{alias}/permissions/users/{username}", s.handleUserGrant)
	s.mux.HandleFunc("PUT /api/notes/{alias}/permissions/groups/{group}", s.handleGroupGrant)
	s.mux.HandleFunc("DELETE /api/notes/{alias}/permissions/groups/{group}", s.handleGroupGrant)
	s.mux.HandleFunc("PUT /api/notes/{alias}/permissions/owner", s.handleSetOwner)
	s.mux.HandleFunc("PUT /api/notes/{alias}/agent-policy", s.handleSetAgentPolicy)
	s.mux.HandleFunc("POST /api/notes/{alias}/share-links", s.handleCreateShareLink)
	s.mux.HandleFunc("DELETE /api/notes/{alias}/share-links/{id}", s.handleDeleteShareLink)
	s.mux.Handle("/", s.uiHandler())
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type apiError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var e apiError
	e.Error.Code = code
	e.Error.Message = message
	writeJSON(w, status, e)
}

// checkOrigin rejects cross-site browser requests that change state. Bearer callers send no Origin.
func (s *Server) checkOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookieFree := r.Header.Get("Authorization") != "" || r.URL.Path == "/oauth/token" ||
			r.URL.Path == "/oauth/register" || r.URL.Path == "/oauth/revoke"
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if cookieFree {
				break
			}
			if origin := r.Header.Get("Origin"); origin != "" && origin != s.baseURL(r) {
				writeError(w, http.StatusForbidden, "cross_origin", "cross-origin request refused")
				return
			}
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				writeError(w, http.StatusForbidden, "cross_origin", "cross-origin request refused")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
