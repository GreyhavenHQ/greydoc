package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/greyhavenhq/greydoc/internal/store"
)

// noteAny loads the {alias} note, in the trash or not, and checks the caller may trash or restore it.
func (s *Server) noteAny(w http.ResponseWriter, r *http.Request) (*store.Note, bool) {
	n, err := s.store.NoteByAlias(r.Context(), r.PathValue("alias"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "no such document")
		return nil, false
	}
	if err != nil {
		internalError(w, err)
		return nil, false
	}
	if err := s.canTrash(identityFrom(r.Context()), n); err != nil {
		if identityFrom(r.Context()) == nil {
			writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
		} else {
			writeError(w, http.StatusForbidden, "forbidden", err.Error())
		}
		return nil, false
	}
	return n, true
}

func noteData(n *store.Note) map[string]any {
	return map[string]any{"alias": n.PrimaryAlias, "title": n.Title}
}

func (s *Server) trashNote(ctx context.Context, id *Identity, n *store.Note) error {
	if err := s.store.TrashNote(ctx, n.ID, id.displayName(), id.event(n.ID, "note.trash", noteData(n))); err != nil {
		return err
	}
	s.notifyNoteGone(n, "trashed")
	return nil
}

func (s *Server) restoreNote(ctx context.Context, id *Identity, n *store.Note) error {
	return s.store.RestoreNote(ctx, n.ID, id.event(n.ID, "note.restore", noteData(n)))
}

// purgeNote deletes a trashed note for good, with its uploads.
func (s *Server) purgeNote(ctx context.Context, ev *store.Event, n *store.Note) error {
	media, _ := s.store.NoteMedia(ctx, n.ID)
	if err := s.store.DeleteNote(ctx, n.ID); err != nil {
		return err
	}
	s.removeNoteMedia(media)
	_ = s.store.AddEvent(ctx, ev)
	s.notifyNoteGone(n, "deleted")
	return nil
}

// handleDeleteNote moves a note to the trash. With ?permanent=1 it deletes a note that is already in the trash.
func (s *Server) handleDeleteNote(w http.ResponseWriter, r *http.Request) {
	n, ok := s.noteAny(w, r)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	if r.URL.Query().Get("permanent") == "1" {
		if n.DeletedAt == "" {
			writeError(w, http.StatusConflict, "not_in_trash", "move the document to the trash first")
			return
		}
		if id.isAgent() {
			writeError(w, http.StatusForbidden, "forbidden", "agents cannot delete documents for good")
			return
		}
		if err := s.purgeNote(r.Context(), id.event(n.ID, "note.delete", noteData(n)), n); err != nil {
			s.writeNoteError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if n.DeletedAt != "" {
		writeError(w, http.StatusGone, "in_trash", "this document is already in the trash")
		return
	}
	if err := s.trashNote(r.Context(), id, n); err != nil {
		s.writeNoteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRestoreNote(w http.ResponseWriter, r *http.Request) {
	n, ok := s.noteAny(w, r)
	if !ok {
		return
	}
	if n.DeletedAt == "" {
		writeError(w, http.StatusConflict, "not_in_trash", "this document is not in the trash")
		return
	}
	if err := s.restoreNote(r.Context(), identityFrom(r.Context()), n); err != nil {
		s.writeNoteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"alias": n.PrimaryAlias})
}

func (s *Server) handleTrash(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
		return
	}
	notes, err := s.store.Trash(r.Context(), s.viewer(id))
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": notes, "retention_days": int(s.cfg.TrashRetention.Hours() / 24)})
}

// PurgeTrash deletes notes that stayed in the trash longer than the retention period.
func (s *Server) PurgeTrash(ctx context.Context) error {
	ids, err := s.store.TrashedBefore(ctx, time.Now().Add(-s.cfg.TrashRetention))
	if err != nil {
		return err
	}
	for _, noteID := range ids {
		n, err := s.store.NoteByID(ctx, noteID)
		if err != nil {
			continue
		}
		data := noteData(n)
		data["reason"] = "trash retention"
		ev := &store.Event{NoteID: n.ID, ActorName: "greydoc", Source: store.SourceSystem, Kind: "note.delete", Data: data}
		if err := s.purgeNote(ctx, ev, n); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) trashLoop() {
	defer s.workers.Done()
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		if err := s.PurgeTrash(ctx); err != nil {
			slog.Error("trash purge failed", "error", err)
		}
		if err := s.store.PurgeExpiredTokens(ctx); err != nil {
			slog.Error("token purge failed", "error", err)
		}
		cancel()
		select {
		case <-s.stop:
			return
		case <-t.C:
		}
	}
}

func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil || id.isAgent() {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
		return
	}
	q := r.URL.Query()
	f := store.AuditFilter{Viewer: s.viewer(id), Kind: q.Get("kind"), Actor: q.Get("actor"), Source: q.Get("source"),
		Before: q.Get("before"), Limit: 100}
	if alias := q.Get("note"); alias != "" {
		if n, err := s.store.NoteByAlias(r.Context(), alias); err == nil {
			f.NoteID = n.ID
		} else {
			f.NoteID = alias
		}
	}
	events, err := s.store.Audit(r.Context(), f)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events, "all": f.Viewer.Local || f.Viewer.Admin})
}
