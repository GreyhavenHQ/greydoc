// Package server is the HTTP layer: JSON API, websocket sync, MCP and the embedded UI.
package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/greyhavenhq/greydoc/internal/config"
	"github.com/greyhavenhq/greydoc/internal/secrets"
	"github.com/greyhavenhq/greydoc/internal/store"
)

type Server struct {
	cfg    config.Config
	store  *store.Store
	secret []byte
	mux    *http.ServeMux
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
	s.routes()
	return s, nil
}

func (s *Server) Store() *store.Store { return s.store }

func (s *Server) Close() error { return s.store.Close() }

func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
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
