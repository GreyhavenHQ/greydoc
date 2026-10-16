package server

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

// The React app in ui/ builds into uidist/ (just ui), which is embedded. Only .gitkeep is tracked.

//go:embed all:uidist
var uiDist embed.FS

// uiIndexFallback replaces index.html when the UI is not built. Tests set it.
var uiIndexFallback []byte

func (s *Server) uiHandler() http.Handler {
	dist, err := fs.Sub(uiDist, "uidist")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServerFS(dist)
	index, err := fs.ReadFile(dist, "index.html")
	if err != nil {
		index = uiIndexFallback
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeError(w, http.StatusNotFound, "not_found", "no such endpoint")
			return
		}
		if s.hedgedocPath(w, r) {
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path != "" {
			if f, err := dist.Open(path); err == nil {
				_ = f.Close()
				if strings.HasPrefix(path, "assets/") || strings.HasPrefix(path, "fonts/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		if index == nil {
			http.Error(w, "UI not built: run just ui", http.StatusServiceUnavailable)
			return
		}
		s.serveIndex(w, r, index)
	})
}
