package server

import (
	"errors"
	"net/http"
	"strings"

	"github.com/greyhavenhq/greydoc/internal/store"
)

// adminFor lets only a signed-in admin, in a browser, manage groups. It writes the error response itself.
func (s *Server) adminFor(w http.ResponseWriter, r *http.Request) (*Identity, bool) {
	id := identityFrom(r.Context())
	switch {
	case s.cfg.LocalMode():
		writeError(w, http.StatusNotFound, "not_found", "groups need sign-in through OIDC")
	case id == nil:
		writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
	case !id.Admin || id.isAgent():
		writeError(w, http.StatusForbidden, "forbidden", "only admins manage groups")
	default:
		return id, true
	}
	return nil, false
}

const memberPreview = 5

func writeGroupError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "no such group")
	case errors.Is(err, store.ErrGroupNameTaken):
		writeError(w, http.StatusConflict, "name_taken", err.Error())
	case errors.Is(err, store.ErrGroupLinkTaken):
		writeError(w, http.StatusConflict, "link_taken", err.Error())
	case errors.Is(err, store.ErrGroupKind):
		writeError(w, http.StatusBadRequest, "kind_fixed", err.Error())
	case errors.Is(err, store.ErrGroupLinked):
		writeError(w, http.StatusBadRequest, "linked_group", err.Error())
	default:
		internalError(w, err)
	}
}

type groupIn struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	OIDCGroup   *string `json:"oidc_group"`
}

// apply merges the request into g and checks the result.
func (in groupIn) apply(w http.ResponseWriter, g *store.Group) bool {
	if in.Name != nil {
		g.Name = strings.TrimSpace(*in.Name)
	}
	if in.Description != nil {
		g.Description = strings.TrimSpace(*in.Description)
	}
	if in.OIDCGroup != nil {
		g.OIDCGroup = strings.TrimSpace(*in.OIDCGroup)
	}
	switch {
	case g.Name == "" || len(g.Name) > 80:
		writeError(w, http.StatusBadRequest, "bad_name", "the name must have 1 to 80 characters")
	case len(g.Description) > 500:
		writeError(w, http.StatusBadRequest, "bad_description", "the description must have at most 500 characters")
	case len(g.OIDCGroup) > 200:
		writeError(w, http.StatusBadRequest, "bad_oidc_group", "the OIDC group must have at most 200 characters")
	default:
		return true
	}
	return false
}

// groupsChanged re-checks the open editors of the notes that grant a group.
func (s *Server) groupsChanged(noteIDs []string) {
	if s.hub == nil {
		return
	}
	for _, id := range noteIDs {
		s.hub.PermissionsChanged(id)
	}
}

func (s *Server) handleListGroups(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminFor(w, r); !ok {
		return
	}
	gs, err := s.store.Groups(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	type listed struct {
		store.Group
		// Members holds the first few members, for the avatars of the list.
		Members []store.User `json:"members"`
	}
	out := make([]listed, len(gs))
	for i := range gs {
		members, err := s.store.GroupMembers(r.Context(), &gs[i])
		if err != nil {
			internalError(w, err)
			return
		}
		out[i] = listed{Group: gs[i], Members: members[:min(len(members), memberPreview)]}
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": out})
}

func (s *Server) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := s.adminFor(w, r)
	if !ok {
		return
	}
	var in groupIn
	if !readJSON(w, r, &in) {
		return
	}
	var g store.Group
	if !in.apply(w, &g) {
		return
	}
	ev := id.event("", "group.create", map[string]any{"name": g.Name, "oidc_group": g.OIDCGroup})
	created, err := s.store.CreateGroup(r.Context(), g.Name, g.Description, g.OIDCGroup, ev)
	if err != nil {
		writeGroupError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) writeGroupDetail(w http.ResponseWriter, r *http.Request, groupID string) {
	g, err := s.store.GroupByID(r.Context(), groupID)
	if err != nil {
		writeGroupError(w, err)
		return
	}
	members, err := s.store.GroupMembers(r.Context(), g)
	if err != nil {
		internalError(w, err)
		return
	}
	notes, err := s.store.GroupNotes(r.Context(), g.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"group": g, "members": members, "notes": notes})
}

func (s *Server) handleGetGroup(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.adminFor(w, r); !ok {
		return
	}
	s.writeGroupDetail(w, r, r.PathValue("id"))
}

func (s *Server) handleUpdateGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := s.adminFor(w, r)
	if !ok {
		return
	}
	g, err := s.store.GroupByID(r.Context(), r.PathValue("id"))
	if err != nil {
		writeGroupError(w, err)
		return
	}
	var in groupIn
	if !readJSON(w, r, &in) {
		return
	}
	before := *g
	if !in.apply(w, g) {
		return
	}
	ev := id.event("", "group.update", map[string]any{"id": g.ID, "name": g.Name, "previous_name": before.Name, "oidc_group": g.OIDCGroup})
	updated, err := s.store.UpdateGroup(r.Context(), g.ID, g.Name, g.Description, g.OIDCGroup, ev)
	if err != nil {
		writeGroupError(w, err)
		return
	}
	if updated.OIDCGroup != before.OIDCGroup {
		notes, err := s.store.GroupNoteIDs(r.Context(), g.ID)
		if err != nil {
			internalError(w, err)
			return
		}
		s.groupsChanged(notes)
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := s.adminFor(w, r)
	if !ok {
		return
	}
	g, err := s.store.GroupByID(r.Context(), r.PathValue("id"))
	if err != nil {
		writeGroupError(w, err)
		return
	}
	notes, err := s.store.DeleteGroup(r.Context(), g.ID, id.event("", "group.delete", map[string]any{"id": g.ID, "name": g.Name, "notes": g.NoteCount}))
	if err != nil {
		writeGroupError(w, err)
		return
	}
	s.groupsChanged(notes)
	writeJSON(w, http.StatusOK, map[string]any{"notes": len(notes)})
}

func (s *Server) handleGroupMember(w http.ResponseWriter, r *http.Request) {
	id, ok := s.adminFor(w, r)
	if !ok {
		return
	}
	g, err := s.store.GroupByID(r.Context(), r.PathValue("id"))
	if err != nil {
		writeGroupError(w, err)
		return
	}
	u, err := s.store.UserByUsername(r.Context(), r.PathValue("username"))
	if errors.Is(err, store.ErrNotFound) || (err == nil && u.ID == store.LocalUserID) {
		writeError(w, http.StatusNotFound, "unknown_user", "no such user")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	data := map[string]any{"id": g.ID, "name": g.Name, "username": u.Username}
	if r.Method == http.MethodDelete {
		err = s.store.RemoveGroupMember(r.Context(), g.ID, u.ID, id.event("", "group.member.remove", data))
	} else {
		err = s.store.AddGroupMember(r.Context(), g.ID, u.ID, id.event("", "group.member.add", data))
	}
	if r.Method == http.MethodDelete && errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_member", "this user is not a member")
		return
	}
	if err != nil {
		writeGroupError(w, err)
		return
	}
	notes, err := s.store.GroupNoteIDs(r.Context(), g.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	s.groupsChanged(notes)
	s.writeGroupDetail(w, r, g.ID)
}
