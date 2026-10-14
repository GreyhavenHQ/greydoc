// Package server is the HTTP layer: JSON API, websocket sync, MCP and the embedded UI.
package server

import (
	"encoding/json"
	"net/http"

	"github.com/greyhavenhq/greydoc/internal/config"
)

type Server struct {
	cfg config.Config
	mux *http.ServeMux
}

func Open(cfg config.Config) (*Server, error) {
	s := &Server{cfg: cfg, mux: http.NewServeMux()}
	s.routes()
	return s, nil
}

func (s *Server) Close() error { return nil }

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
