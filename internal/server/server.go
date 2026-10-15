// Package server is the HTTP layer: JSON API, websocket sync, MCP and the embedded UI.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/greyhavenhq/greydoc/internal/ai"
	"github.com/greyhavenhq/greydoc/internal/collab"
	"github.com/greyhavenhq/greydoc/internal/config"
	"github.com/greyhavenhq/greydoc/internal/history"
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
	history       *history.Processor
	stop          chan struct{}
	workers       sync.WaitGroup
	closeOnce     sync.Once
	closeErr      error
	noteLocks     sync.Map
	ai            *ai.Client
	aiLimit       *rateLimiter
	aiPresets     []ai.Preset
	seenBase      atomic.Value
	resizeMu      sync.Mutex
}

func Open(cfg config.Config) (*Server, error) {
	_, statErr := os.Stat(cfg.SecretFile)
	newSecret := cfg.Secret == "" && statErr != nil
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
	if newSecret {
		if has, err := st.HasCredentials(ctx); err == nil && has {
			// Sessions and tokens are stored as hashes made with the secret, so none of them match any more.
			slog.Warn("created a new secret, so every browser session and MCP token stopped working. "+
				"Keep the secret file on a persistent volume, or set GREYDOC_SECRET to a fixed value.", "secret_file", cfg.SecretFile)
		}
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
		// OAuth metadata and login redirects must not follow request headers.
		if cfg.BaseURL == "" {
			st.Close()
			return nil, fmt.Errorf("GREYDOC_BASE_URL is required when GREYDOC_OIDC_ISSUER is set")
		}
		s.sso, err = oidc.Discover(ctx, oidc.Config{Issuer: cfg.OIDCIssuer, ClientID: cfg.OIDCClientID,
			ClientSecret: cfg.OIDCClientSecret, Scopes: cfg.OIDCScopes, GroupsClaim: cfg.OIDCGroupsClaim})
		if err != nil {
			st.Close()
			return nil, err
		}
	}
	s.history = &history.Processor{Store: st}
	if cfg.AIEnabled() {
		s.ai = ai.New(cfg.LLMBaseURL, cfg.LLMAPIKey, cfg.LLMModel)
		if s.aiPresets, err = ai.LoadPresets(cfg.AIActions); err != nil {
			st.Close()
			return nil, err
		}
		s.aiLimit = newRateLimiter(cfg.AIRatePerMinute, time.Minute)
	}
	s.stop = make(chan struct{})
	s.hub = collab.NewHub(roomStore{st: st}, collab.Options{IdleGrace: cfg.RoomIdleGrace, SaveInterval: cfg.RoomSaveEvery,
		OnClosed: s.afterClose})
	s.routes()
	s.workers.Add(2)
	go s.historyLoop()
	go s.trashLoop()
	return s, nil
}

func (s *Server) Store() *store.Store { return s.store }

func (s *Server) Close() error {
	s.closeOnce.Do(func() {
		close(s.stop)
		s.workers.Wait()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		s.hub.Shutdown(ctx)
		s.closeErr = s.store.Close()
	})
	return s.closeErr
}

// LiveText returns the text of a note open in the hub.
func (s *Server) LiveText(noteID string) (string, bool) { return s.hub.LiveText(noteID) }

func (s *Server) afterClose(noteID string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := s.history.Process(ctx, noteID, true); err != nil {
		slog.Error("history processing failed", "note", noteID, "error", err)
	}
}

func (s *Server) historyLoop() {
	defer s.workers.Done()
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			if err := s.ProcessHistory(ctx, false); err != nil {
				slog.Error("history processing failed", "error", err)
			}
			cancel()
		}
	}
}

// ProcessHistory turns logged updates of every note into revisions. force also closes open sessions.
func (s *Server) ProcessHistory(ctx context.Context, force bool) error {
	s.hub.Flush("")
	ids, err := s.store.NotesWithPendingHistory(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := s.history.Process(ctx, id, force); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) Handler() http.Handler { return s.withTiming(s.checkOrigin(s.withIdentity(s.mux))) }

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", s.handleHealthz)
	s.mux.HandleFunc("GET /auth/login", s.handleAuthLogin)
	s.mux.HandleFunc("GET /auth/callback", s.handleAuthCallback)
	s.mux.HandleFunc("POST /auth/logout", s.handleAuthLogout)
	s.mux.HandleFunc("GET /api/me", s.handleMe)
	s.mux.HandleFunc("GET /api/users", s.handleSearchUsers)
	s.mux.HandleFunc("GET /api/tokens", s.handleListTokens)
	s.mux.HandleFunc("POST /api/tokens", s.handleCreateToken)
	s.mux.HandleFunc("DELETE /api/tokens/{id}", s.handleDeleteToken)

	s.mux.HandleFunc("GET /.well-known/oauth-protected-resource", s.handleResourceMetadata)
	s.mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", s.handleResourceMetadata)
	s.mux.HandleFunc("GET /.well-known/oauth-authorization-server", s.handleASMetadata)
	s.mux.HandleFunc("GET /.well-known/oauth-authorization-server/mcp", s.handleASMetadata)
	s.mux.HandleFunc("GET /.well-known/openid-configuration", s.handleASMetadata)
	s.mux.HandleFunc("POST /oauth/register", s.handleRegister)
	s.mux.HandleFunc("GET /oauth/authorize", s.handleAuthorize)
	s.mux.HandleFunc("POST /oauth/authorize", s.handleAuthorizeDecision)
	s.mux.HandleFunc("POST /oauth/token", s.handleToken)
	s.mux.HandleFunc("POST /oauth/revoke", s.handleRevoke)
	s.mux.Handle("/mcp", s.mcpHandler())

	s.mux.HandleFunc("GET /api/notes", s.handleListNotes)
	s.mux.HandleFunc("GET /api/tags", s.handleTags)
	s.mux.HandleFunc("GET /api/trash", s.handleTrash)
	s.mux.HandleFunc("GET /api/audit", s.handleAudit)
	s.mux.HandleFunc("GET /api/audit/mcp", s.handleMCPUsage)
	s.mux.HandleFunc("POST /api/notes/{alias}/restore", s.handleRestoreNote)
	s.mux.HandleFunc("POST /api/notes", s.handleCreateNote)
	s.mux.HandleFunc("POST /api/notes/import", s.handleImportBundle)
	s.mux.HandleFunc("GET /api/share/{token}", s.handleResolveShare)
	s.mux.HandleFunc("POST /new", s.handleHedgeDocNew)
	s.mux.HandleFunc("POST /new/{alias}", s.handleHedgeDocNew)
	s.mux.HandleFunc("PUT /api/notes/{alias}/pin", s.handlePin)
	s.mux.HandleFunc("DELETE /api/notes/{alias}/pin", s.handlePin)
	s.mux.HandleFunc("DELETE /api/notes/{alias}/visit", s.handleForgetVisit)
	s.mux.HandleFunc("GET /api/notes/{alias}", s.handleGetNote)
	s.mux.HandleFunc("DELETE /api/notes/{alias}", s.handleDeleteNote)
	s.mux.HandleFunc("GET /api/notes/{alias}/content", s.handleGetNoteContent)
	s.mux.HandleFunc("GET /api/notes/{alias}/download.md", s.handleDownloadMarkdown)
	s.mux.HandleFunc("GET /api/notes/{alias}/export.zip", s.handleExportBundle)
	s.mux.HandleFunc("POST /api/notes/{alias}/media", s.handleUpload)
	s.mux.HandleFunc("GET /uploads/{name}", s.handleServeUpload)
	s.mux.HandleFunc("POST /api/uploads/{ticket}", s.handleTicketUpload)
	s.mux.HandleFunc("POST /api/notes/{alias}/aliases", s.handleAliases)
	s.mux.HandleFunc("PUT /api/notes/{alias}/aliases", s.handleAliases)
	s.mux.HandleFunc("DELETE /api/notes/{alias}/aliases/{name}", s.handleAliases)

	s.mux.HandleFunc("GET /ws/{alias}", s.handleWS)
	s.mux.HandleFunc("GET /api/notes/{alias}/timeline", s.handleTimeline)
	s.mux.HandleFunc("GET /api/notes/{alias}/revisions/{id}", s.handleRevision)
	s.mux.HandleFunc("POST /api/notes/{alias}/revisions/{id}/restore", s.handleRestore)
	s.mux.HandleFunc("GET /api/notes/{alias}/clients", s.handleClients)
	s.mux.HandleFunc("GET /api/notes/{alias}/comments", s.handleListComments)
	s.mux.HandleFunc("POST /api/notes/{alias}/comments", s.handleCreateComment)
	s.mux.HandleFunc("POST /api/notes/{alias}/comments/{thread}/replies", s.handleReply)
	s.mux.HandleFunc("POST /api/notes/{alias}/comments/{thread}/resolve", s.handleThreadStatus)
	s.mux.HandleFunc("POST /api/notes/{alias}/comments/{thread}/reopen", s.handleThreadStatus)
	s.mux.HandleFunc("DELETE /api/notes/{alias}/comments/{thread}", s.handleDeleteThread)
	s.mux.HandleFunc("PATCH /api/notes/{alias}/comments/{thread}/{comment}", s.handleEditComment)
	s.mux.HandleFunc("POST /api/notes/{alias}/ai", s.handleAI)
	s.mux.HandleFunc("GET /api/notes/{alias}/suggestions", s.handleListSuggestions)
	s.mux.HandleFunc("POST /api/notes/{alias}/suggestions", s.handleCreateSuggestion)
	s.mux.HandleFunc("GET /api/notes/{alias}/suggestions/{id}", s.handleGetSuggestion)
	s.mux.HandleFunc("POST /api/notes/{alias}/suggestions/{id}/revise", s.handleReviseSuggestion)
	s.mux.HandleFunc("POST /api/notes/{alias}/suggestions/{id}/accept", func(w http.ResponseWriter, r *http.Request) { s.handleDecideSuggestion(w, r, true) })
	s.mux.HandleFunc("POST /api/notes/{alias}/suggestions/{id}/reject", func(w http.ResponseWriter, r *http.Request) { s.handleDecideSuggestion(w, r, false) })

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
	// Browsers may cache some statuses, such as 410, without headers. API answers change, so none are cached.
	if w.Header().Get("Cache-Control") == "" {
		w.Header().Set("Cache-Control", "no-store")
	}
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

// handleHealthz answers 200 when the server and its database work, for container health checks.
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "error", "error": "database unreachable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
