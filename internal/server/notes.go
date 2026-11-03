package server

import (
	"context"
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
	// Folder is the note's folder, when the caller can open it.
	Folder *folderRef `json:"folder,omitempty"`
}

func (s *Server) handleCreateNote(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in to create documents")
		return
	}
	var spec NoteSpec
	ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if ct == "text/markdown" || ct == "text/plain" {
		b, err := io.ReadAll(io.LimitReader(r.Body, int64(s.cfg.MaxNoteLength)*4+1))
		if err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "could not read body")
			return
		}
		spec.Content = string(b)
		spec.Alias = r.URL.Query().Get("alias")
	} else if r.ContentLength != 0 && !readJSON(w, r, &spec) {
		return
	}
	n, err := s.createNote(r.Context(), id, spec)
	if err != nil {
		s.writeHTTPError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, noteView{Note: n, Level: permission.Full})
}

var errMaxLength = errors.New("document exceeds the maximum length")

func (s *Server) createNote(ctx context.Context, id *Identity, spec NoteSpec) (*store.Note, error) {
	if utf8.RuneCountInString(spec.Content) > s.cfg.MaxNoteLength {
		return nil, errMaxLength
	}
	if spec.Folder != "" {
		if _, _, err := s.liveFolder(ctx, id, spec.Folder, permission.Write); err != nil {
			return nil, err
		}
	}
	nn, err := s.noteFromSpec(ctx, id, spec)
	if err != nil {
		return nil, err
	}
	n, err := s.store.CreateNote(ctx, nn)
	if err != nil {
		return nil, err
	}
	if spec.Content != "" {
		if _, err := s.hub.Edit(ctx, n.ID, collab.Author{UserID: id.UserID(), Name: id.displayName(), Source: string(id.source())},
			func(collab.EditView) (string, error) { return spec.Content, nil }); err != nil {
			return nil, err
		}
		meta := notemeta.Extract(spec.Content)
		if err := s.store.SaveNoteState(ctx, n.ID, store.NoteState{
			Content: spec.Content, Title: meta.Title, Description: meta.Description, Tags: meta.Tags, Slides: meta.Slides,
		}); err != nil {
			return nil, err
		}
		if nn.CreatedAt != "" {
			if err := s.store.SetNoteTimes(ctx, n.ID, nn.CreatedAt, nn.UpdatedAt); err != nil {
				return nil, err
			}
		}
		if n, err = s.store.NoteByID(ctx, n.ID); err != nil {
			return nil, err
		}
	}
	return n, nil
}

func (s *Server) writeNoteError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errBadSpec):
		writeError(w, http.StatusBadRequest, "bad_settings", err.Error())
	case errors.Is(err, errMaxLength):
		writeError(w, http.StatusRequestEntityTooLarge, "max_length", err.Error())
	case errors.Is(err, store.ErrAliasTaken):
		writeError(w, http.StatusConflict, "alias_taken", err.Error())
	case errors.Is(err, store.ErrAliasForbidden):
		writeError(w, http.StatusBadRequest, "alias_forbidden", err.Error())
	case errors.Is(err, store.ErrPrimaryAliasDeletion):
		writeError(w, http.StatusBadRequest, "primary_alias", err.Error())
	case errors.Is(err, store.ErrNotFound), errors.Is(err, errFolderMissing):
		writeError(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, errFolderTrashed):
		writeError(w, http.StatusGone, "in_trash", err.Error())
	case errors.As(err, new(*levelError)):
		writeError(w, http.StatusForbidden, "forbidden", err.Error())
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
	if r.URL.Query().Get("visit") == "1" {
		id := identityFrom(r.Context())
		if !id.isAgent() {
			_ = s.store.CountView(r.Context(), n.ID)
			n.ViewCount++
		}
		if id != nil {
			_ = s.store.RecordVisit(r.Context(), id.UserID(), n.ID)
		}
	}
	if l >= permission.Write {
		v.Aliases, _ = s.store.Aliases(r.Context(), n.ID)
	}
	if n.OwnerID != "" {
		v.Owner, _ = s.store.UserByID(r.Context(), n.OwnerID)
	}
	if n.FolderID != "" {
		if f, _, err := s.liveFolder(r.Context(), identityFrom(r.Context()), n.FolderID, permission.Read); err == nil {
			v.Folder = &folderRef{f.ID, f.Name}
		}
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

// notifyNoteGone closes the note's live room. reason is trashed or deleted.
func (s *Server) notifyNoteGone(n *store.Note, reason string) {
	s.hub.CloseNote(n.ID, reason)
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
			writeError(w, http.StatusNotFound, "not_found", "no such alias on this document")
			return
		}
		if err := s.store.RemoveAlias(r.Context(), name); err != nil {
			s.writeNoteError(w, err)
			return
		}
		_ = s.store.AddEvent(r.Context(), id.event(n.ID, "alias.remove", map[string]any{"alias": strings.ToLower(name)}))
	}
	aliases, _ := s.store.Aliases(r.Context(), n.ID)
	writeJSON(w, http.StatusOK, map[string]any{"aliases": aliases})
}

// handleSlug sets the custom slug of a note. The previous custom slug stops working; the id address always works.
func (s *Server) handleSlug(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Full)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	if !id.canWriteScope() {
		writeError(w, http.StatusForbidden, "forbidden", "this token can only read")
		return
	}
	var req struct {
		Slug string `json:"slug"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	alias, err := s.store.SetSlug(r.Context(), n.ID, req.Slug, id.event(n.ID, "alias.change", nil))
	if err != nil {
		s.writeNoteError(w, err)
		return
	}
	if alias != n.PrimaryAlias {
		s.hub.Broadcast(n.ID, map[string]any{"type": "alias", "alias": alias})
	}
	aliases, _ := s.store.Aliases(r.Context(), n.ID)
	writeJSON(w, http.StatusOK, map[string]any{"alias": alias, "aliases": aliases})
}
