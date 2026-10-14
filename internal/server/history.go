package server

import (
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/greyhavenhq/greydoc/internal/collab"
	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// timelineEntry is one row of the note timeline: a revision or an audit event.
type timelineEntry struct {
	Kind     string          `json:"kind"`
	At       string          `json:"at"`
	Revision *store.Revision `json:"revision,omitempty"`
	Event    *store.Event    `json:"event,omitempty"`
}

type pendingView struct {
	Authors []store.RevisionAuthor `json:"authors"`
	Since   string                 `json:"since"`
}

func (s *Server) handleTimeline(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	s.hub.Flush(n.ID)
	_ = s.history.Process(r.Context(), n.ID, false)
	revs, err := s.store.Revisions(r.Context(), n.ID, 500)
	if err != nil {
		internalError(w, err)
		return
	}
	events, err := s.store.Events(r.Context(), n.ID, 500)
	if err != nil {
		internalError(w, err)
		return
	}
	entries := make([]timelineEntry, 0, len(revs)+len(events))
	for i := range revs {
		entries = append(entries, timelineEntry{Kind: "revision", At: revs[i].EndedAt, Revision: &revs[i]})
	}
	for i := range events {
		// Agent calls are in the audit log. The note timeline keeps what changed the note.
		if strings.HasPrefix(events[i].Kind, "mcp.") {
			continue
		}
		entries = append(entries, timelineEntry{Kind: "event", At: events[i].CreatedAt, Event: &events[i]})
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].At > entries[j].At })

	var pending *pendingView
	upto, _, err := s.store.HistoryCursor(r.Context(), n.ID)
	if err == nil {
		if ups, err := s.store.UpdatesBetween(r.Context(), n.ID, upto, 0); err == nil && len(ups) > 0 {
			pending = &pendingView{Since: ups[0].CreatedAt}
			seen := map[string]bool{}
			for _, u := range ups {
				if key := u.UserID + string(u.Source); !seen[key] {
					seen[key] = true
					pending.Authors = append(pending.Authors, store.RevisionAuthor{UserID: u.UserID, Name: u.Name, Source: u.Source})
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries, "pending": pending})
}

func (s *Server) revisionFor(w http.ResponseWriter, r *http.Request, n *store.Note) (*store.Revision, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_id", "invalid revision id")
		return nil, false
	}
	rev, err := s.store.Revision(r.Context(), n.ID, id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "no such revision")
		return nil, false
	}
	if err != nil {
		internalError(w, err)
		return nil, false
	}
	return rev, true
}

func (s *Server) handleRevision(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	if rev, ok := s.revisionFor(w, r, n); ok {
		writeJSON(w, http.StatusOK, rev)
	}
}

func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Write)
	if !ok {
		return
	}
	rev, ok := s.revisionFor(w, r, n)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	if _, err := s.hub.Edit(r.Context(), n.ID, collab.Author{UserID: id.UserID(), Name: id.displayName(), Source: string(store.SourceRestore)},
		func(collab.EditView) (string, error) { return rev.Text, nil }); err != nil {
		internalError(w, err)
		return
	}
	_ = s.store.AddEvent(r.Context(), id.event(n.ID, "revision.restore", map[string]any{"revision": rev.ID, "at": rev.EndedAt}))
	s.hub.Broadcast(n.ID, map[string]any{"type": "timeline"})
	writeJSON(w, http.StatusOK, map[string]any{"restored": rev.ID, "at": time.Now().UTC()})
}

func (s *Server) handleClients(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	clients, err := s.store.NoteClients(r.Context(), n.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"clients": clients})
}
