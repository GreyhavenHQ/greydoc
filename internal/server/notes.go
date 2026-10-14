package server

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/greyhavenhq/greydoc/internal/collab"
	"github.com/greyhavenhq/greydoc/internal/notemeta"
	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

func internalError(w http.ResponseWriter, err error) {
	slog.Error("internal error", "error", err)
	writeError(w, http.StatusInternalServerError, "internal", "internal error")
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return false
	}
	return true
}

type noteView struct {
	*store.Note
	Level   permission.Level `json:"level"`
	Content *string          `json:"content,omitempty"`
	Aliases []store.Alias    `json:"aliases,omitempty"`
	Owner   *store.User      `json:"owner,omitempty"`
}

func (s *Server) handleCreateNote(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in to create notes")
		return
	}
	var req struct {
		Content string `json:"content"`
		Alias   string `json:"alias"`
	}
	ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if ct == "text/markdown" || ct == "text/plain" {
		b, err := io.ReadAll(io.LimitReader(r.Body, int64(s.cfg.MaxNoteLength)*4+1))
		if err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "could not read body")
			return
		}
		req.Content = string(b)
		req.Alias = r.URL.Query().Get("alias")
	} else if r.ContentLength != 0 && !readJSON(w, r, &req) {
		return
	}
	n, err := s.createNote(r, id, req.Content, req.Alias)
	if err != nil {
		s.writeNoteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, noteView{Note: n, Level: permission.Full})
}

var errMaxLength = errors.New("note exceeds the maximum length")

func (s *Server) createNote(r *http.Request, id *Identity, content, alias string) (*store.Note, error) {
	if utf8.RuneCountInString(content) > s.cfg.MaxNoteLength {
		return nil, errMaxLength
	}
	n, err := s.store.CreateNote(r.Context(), store.NewNote{
		OwnerID: id.UserID(), Alias: alias, Groups: s.defaultGroups,
		Event: id.event("", "note.create", nil),
	})
	if err != nil {
		return nil, err
	}
	if content != "" {
		if _, err := s.hub.Edit(r.Context(), n.ID, collab.Author{UserID: id.UserID(), Name: id.displayName(), Source: string(id.source())},
			func(collab.EditView) (string, error) { return content, nil }); err != nil {
			return nil, err
		}
		meta := notemeta.Extract(content)
		if err := s.store.SaveNoteState(r.Context(), n.ID, store.NoteState{
			Content: content, Title: meta.Title, Description: meta.Description, Tags: meta.Tags,
		}); err != nil {
			return nil, err
		}
		n.Title, n.Description, n.Tags = meta.Title, meta.Description, meta.Tags
	}
	s.mirror.Touch(n.ID)
	return n, nil
}

func (s *Server) writeNoteError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errMaxLength):
		writeError(w, http.StatusRequestEntityTooLarge, "max_length", err.Error())
	case errors.Is(err, store.ErrAliasTaken):
		writeError(w, http.StatusConflict, "alias_taken", err.Error())
	case errors.Is(err, store.ErrAliasForbidden):
		writeError(w, http.StatusBadRequest, "alias_forbidden", err.Error())
	case errors.Is(err, store.ErrPrimaryAliasDeletion):
		writeError(w, http.StatusBadRequest, "primary_alias", err.Error())
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", err.Error())
	default:
		internalError(w, err)
	}
}

// noteContent returns the live text when the note is open in the hub, else the stored text.
func (s *Server) noteContent(n *store.Note) string {
	if text, ok := s.hub.LiveText(n.ID); ok {
		return text
	}
	return n.Content
}

func (s *Server) handleGetNote(w http.ResponseWriter, r *http.Request) {
	n, l, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	content := s.noteContent(n)
	v := noteView{Note: n, Level: l, Content: &content}
	if id := identityFrom(r.Context()); id != nil && r.URL.Query().Get("visit") == "1" {
		_ = s.store.RecordVisit(r.Context(), id.UserID(), n.ID)
	}
	if l >= permission.Write {
		v.Aliases, _ = s.store.Aliases(r.Context(), n.ID)
	}
	if n.OwnerID != "" {
		v.Owner, _ = s.store.UserByID(r.Context(), n.OwnerID)
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleGetNoteContent(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	_, _ = io.WriteString(w, s.noteContent(n))
}

func (s *Server) handleDeleteNote(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Full)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	media, _ := s.store.NoteMedia(r.Context(), n.ID)
	if err := s.store.DeleteNote(r.Context(), n.ID); err != nil {
		s.writeNoteError(w, err)
		return
	}
	s.removeNoteMedia(media)
	_ = s.store.AddEvent(r.Context(), id.event(n.ID, "note.delete", map[string]any{"alias": n.PrimaryAlias, "title": n.Title}))
	s.notifyNoteDeleted(n)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) notifyNoteDeleted(n *store.Note) {
	s.hub.CloseNote(n.ID, "deleted")
	s.mirror.Remove(n.ID)
}

func (s *Server) handleAliases(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Full)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	var req struct {
		Name    string `json:"name"`
		Primary bool   `json:"primary"`
	}
	switch r.Method {
	case http.MethodPost:
		if !readJSON(w, r, &req) {
			return
		}
		if err := s.store.AddAlias(r.Context(), n.ID, req.Name); err != nil {
			s.writeNoteError(w, err)
			return
		}
		if req.Primary {
			if err := s.store.MakeAliasPrimary(r.Context(), n.ID, req.Name); err != nil {
				s.writeNoteError(w, err)
				return
			}
		}
		_ = s.store.AddEvent(r.Context(), id.event(n.ID, "alias.add", map[string]any{"alias": strings.ToLower(req.Name), "primary": req.Primary}))
	case http.MethodPut:
		if !readJSON(w, r, &req) {
			return
		}
		if err := s.store.MakeAliasPrimary(r.Context(), n.ID, req.Name); err != nil {
			s.writeNoteError(w, err)
			return
		}
		_ = s.store.AddEvent(r.Context(), id.event(n.ID, "alias.primary", map[string]any{"alias": strings.ToLower(req.Name)}))
	case http.MethodDelete:
		name := r.PathValue("name")
		if a, _ := s.store.NoteByAlias(r.Context(), name); a == nil || a.ID != n.ID {
			writeError(w, http.StatusNotFound, "not_found", "no such alias on this note")
			return
		}
		if err := s.store.RemoveAlias(r.Context(), name); err != nil {
			s.writeNoteError(w, err)
			return
		}
		_ = s.store.AddEvent(r.Context(), id.event(n.ID, "alias.remove", map[string]any{"alias": strings.ToLower(name)}))
	}
	s.mirror.Touch(n.ID)
	aliases, _ := s.store.Aliases(r.Context(), n.ID)
	writeJSON(w, http.StatusOK, map[string]any{"aliases": aliases})
}
