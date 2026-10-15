package server

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// HedgeDoc 1 addresses: /<id>/publish, /<id>/slide, /<id>/download and /<id>/info.
// They run on the server, so scripts and curl get the same answers as with HedgeDoc 1.
func (s *Server) hedgedocPath(w http.ResponseWriter, r *http.Request) bool {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 2 {
		return false
	}
	alias, action := parts[0], parts[1]
	switch action {
	case "publish", "slide", "download", "info":
	default:
		return false
	}
	if _, err := store.NormalizeAlias(alias); err != nil {
		return false
	}
	switch action {
	case "publish", "slide":
		prefix := "/s/"
		if action == "slide" {
			prefix = "/p/"
		}
		target := prefix + url.PathEscape(alias)
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusFound)
	case "download":
		r.SetPathValue("alias", alias)
		s.handleDownloadMarkdown(w, r)
	case "info":
		r.SetPathValue("alias", alias)
		s.handleHedgeDocInfo(w, r)
	}
	return true
}

func hedgedocTime(t string) string {
	return store.ParseTime(t).UTC().Format("2006-01-02T15:04:05.000Z")
}

// handleHedgeDocInfo answers like HedgeDoc 1's /<id>/info.
func (s *Server) handleHedgeDocInfo(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"title": n.Title, "description": n.Description, "viewcount": n.ViewCount,
		"createtime": hedgedocTime(n.CreatedAt), "updatetime": hedgedocTime(n.UpdatedAt),
	})
}

// handleHedgeDocNew is HedgeDoc 1's POST /new and POST /new/<alias>: the body is the Markdown text.
func (s *Server) handleHedgeDocNew(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in to create notes")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, int64(s.cfg.MaxNoteLength)*4+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "could not read body")
		return
	}
	n, err := s.createNote(context.WithoutCancel(r.Context()), id, NoteSpec{Content: string(body), Alias: r.PathValue("alias")})
	if err != nil {
		s.writeHTTPError(w, err)
		return
	}
	http.Redirect(w, r, "/n/"+n.PrimaryAlias, http.StatusFound)
}
