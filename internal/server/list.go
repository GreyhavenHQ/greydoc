package server

import (
	"net/http"
	"sort"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

func (s *Server) viewer(id *Identity) store.Viewer {
	if id == nil {
		return store.Viewer{}
	}
	if id.Local {
		return store.Viewer{Local: true, UserID: id.UserID()}
	}
	return store.Viewer{UserID: id.UserID(), Groups: id.User.Groups}
}

func (s *Server) handleListNotes(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in to list notes")
		return
	}
	q := r.URL.Query()
	f := store.ListFilter{Viewer: s.viewer(id), Scope: store.Scope(q.Get("scope")), Tag: q.Get("tag")}
	if f.Scope == "" {
		f.Scope = store.ScopeAll
	}
	if text := q.Get("q"); text != "" {
		ids, err := s.store.SearchNoteIDs(r.Context(), text, 200)
		if err != nil {
			internalError(w, err)
			return
		}
		f.IDs = ids
	}
	notes, err := s.store.ListNotes(r.Context(), f)
	if err != nil {
		internalError(w, err)
		return
	}
	if f.IDs != nil {
		rank := map[string]int{}
		for i, id := range f.IDs {
			rank[id] = i
		}
		sort.SliceStable(notes, func(i, j int) bool { return rank[notes[i].ID] < rank[notes[j].ID] })
		ids := make([]string, len(notes))
		for i, n := range notes {
			ids[i] = n.ID
		}
		if snips, err := s.store.SearchSnippets(r.Context(), q.Get("q"), ids); err == nil {
			for i := range notes {
				notes[i].Snippet = snips[notes[i].ID]
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": notes})
}

func (s *Server) handleTags(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in to list tags")
		return
	}
	tags, err := s.store.TagCounts(r.Context(), s.viewer(id))
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": tags})
}

func (s *Server) handlePin(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
		return
	}
	var err error
	switch r.Method {
	case http.MethodPut:
		err = s.store.SetPinned(r.Context(), id.UserID(), n.ID, true)
	case http.MethodDelete:
		err = s.store.SetPinned(r.Context(), id.UserID(), n.ID, false)
	}
	if err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleForgetVisit(w http.ResponseWriter, r *http.Request) {
	n, err := s.store.NoteByAlias(r.Context(), r.PathValue("alias"))
	id := identityFrom(r.Context())
	if err != nil || id == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := s.store.ForgetVisit(r.Context(), id.UserID(), n.ID); err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
