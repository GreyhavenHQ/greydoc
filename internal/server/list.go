package server

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// searchCap is how many matches a search ranks before access checks and paging.
const searchCap = 500

func (s *Server) viewer(id *Identity) store.Viewer {
	if id == nil {
		return store.Viewer{}
	}
	if id.Local {
		return store.Viewer{Local: true, Admin: true, UserID: id.UserID()}
	}
	return store.Viewer{UserID: id.UserID(), Groups: id.User.GroupIDs, Admin: id.Admin && !id.isAgent()}
}

func (s *Server) handleListNotes(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in to list documents")
		return
	}
	q := r.URL.Query()
	f := store.ListFilter{Viewer: s.viewer(id), Scope: store.Scope(q.Get("scope")), Tag: q.Get("tag")}
	if f.Scope == "" {
		f.Scope = store.ScopeAll
	}
	var group *store.Group
	if gid := q.Get("group"); gid != "" {
		g, err := s.store.GroupByID(r.Context(), gid)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "unknown_group", "no such group")
			return
		}
		if err != nil {
			internalError(w, err)
			return
		}
		// The filter shows which documents a group can open. Only its members and admins may know.
		if !canUseGroup(id, g) {
			writeError(w, http.StatusForbidden, "not_member", "you can only filter by groups you belong to")
			return
		}
		group, f.Group = g, g.ID
	}
	if folder := q.Get("folder"); folder != "" {
		if folder != store.FolderRoot {
			if _, _, err := s.liveFolder(r.Context(), id, folder, permission.Read); err != nil {
				s.writeFolderError(w, r, err)
				return
			}
		}
		f.Folder = folder
	}
	f.Limit, _ = strconv.Atoi(q.Get("limit"))
	f.Offset, _ = strconv.Atoi(q.Get("offset"))
	if text := q.Get("q"); text != "" {
		ids, err := s.store.SearchNoteIDs(r.Context(), text, searchCap)
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
	out := map[string]any{"notes": notes}
	if group != nil {
		out["group"] = groupRef{ID: group.ID, Name: group.Name}
	}
	writeJSON(w, http.StatusOK, out)
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
