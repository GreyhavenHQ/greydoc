package server

import (
	"errors"
	"net/http"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

type permissionsView struct {
	Owner       *store.User        `json:"owner"`
	Users       []store.UserGrant  `json:"users"`
	Groups      []store.GroupGrant `json:"groups"`
	ShareLinks  []store.ShareLink  `json:"share_links"`
	AgentPolicy store.AgentPolicy  `json:"agent_policy"`
	GuestMax    permission.Level   `json:"guest_max"`
}

func (s *Server) permissionsView(r *http.Request, n *store.Note) (*permissionsView, error) {
	acl, err := s.store.NoteACL(r.Context(), n.ID)
	if err != nil {
		return nil, err
	}
	links, err := s.store.ShareLinks(r.Context(), n.ID)
	if err != nil {
		return nil, err
	}
	v := &permissionsView{Users: acl.Users, Groups: acl.Groups, ShareLinks: links, AgentPolicy: n.AgentPolicy, GuestMax: s.guestMax}
	if acl.OwnerID != "" {
		v.Owner, _ = s.store.UserByID(r.Context(), acl.OwnerID)
	}
	return v, nil
}

func (s *Server) handleGetPermissions(w http.ResponseWriter, r *http.Request) {
	n, l, ok := s.noteFor(w, r, permission.Read)
	if !ok {
		return
	}
	v, err := s.permissionsView(r, n)
	if err != nil {
		internalError(w, err)
		return
	}
	if l < permission.Full {
		// Only the owner sees who else has access. Others see the public grants and their own level.
		v.ShareLinks, v.Users = nil, []store.UserGrant{}
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) respondPermissions(w http.ResponseWriter, r *http.Request, n *store.Note) {
	if s.hub != nil {
		s.hub.PermissionsChanged(n.ID)
	}
	n, err := s.store.NoteByID(r.Context(), n.ID)
	if err != nil {
		internalError(w, err)
		return
	}
	v, err := s.permissionsView(r, n)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func parseGrantLevel(w http.ResponseWriter, r *http.Request) (permission.Level, bool) {
	if r.Method == http.MethodDelete {
		return permission.Deny, true
	}
	var req struct {
		Level string `json:"level"`
	}
	if !readJSON(w, r, &req) {
		return 0, false
	}
	l, ok := permission.ParseLevel(req.Level)
	if !ok || l == permission.Full {
		writeError(w, http.StatusBadRequest, "bad_level", "level must be deny, read, comment or write")
		return 0, false
	}
	return l, true
}

func (s *Server) handleUserGrant(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Full)
	if !ok {
		return
	}
	l, ok := parseGrantLevel(w, r)
	if !ok {
		return
	}
	u, err := s.store.UserByUsername(r.Context(), r.PathValue("username"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "unknown_user", "no such user")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	id := identityFrom(r.Context())
	ev := id.event(n.ID, "permission.user", map[string]any{"username": u.Username, "level": l.String()})
	if err := s.store.SetUserGrant(r.Context(), n.ID, u.ID, l, ev); err != nil {
		internalError(w, err)
		return
	}
	s.respondPermissions(w, r, n)
}

func (s *Server) handleGroupGrant(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Full)
	if !ok {
		return
	}
	l, ok := parseGrantLevel(w, r)
	if !ok {
		return
	}
	group := r.PathValue("group")
	if group != store.GroupEveryone && group != store.GroupSignedIn {
		writeError(w, http.StatusBadRequest, "bad_group", "share with people, signed-in users or anyone with the address")
		return
	}
	if group == store.GroupEveryone && l > s.guestMax {
		writeError(w, http.StatusBadRequest, "above_guest_max", "guests cannot get more than "+s.guestMax.String())
		return
	}
	id := identityFrom(r.Context())
	ev := id.event(n.ID, "permission.group", map[string]any{"group": group, "level": l.String()})
	if err := s.store.SetGroupGrant(r.Context(), n.ID, group, l, ev); err != nil {
		internalError(w, err)
		return
	}
	s.respondPermissions(w, r, n)
}

func (s *Server) handleSetOwner(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Full)
	if !ok {
		return
	}
	var req struct {
		Username string `json:"username"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	u, err := s.store.UserByUsername(r.Context(), req.Username)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "unknown_user", "no such user")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	id := identityFrom(r.Context())
	if err := s.store.SetOwner(r.Context(), n.ID, u.ID, id.event(n.ID, "permission.owner", map[string]any{"username": u.Username})); err != nil {
		internalError(w, err)
		return
	}
	s.respondPermissions(w, r, n)
}

func (s *Server) handleSetAgentPolicy(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Full)
	if !ok {
		return
	}
	var req struct {
		Policy store.AgentPolicy `json:"policy"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if !req.Policy.Valid() {
		writeError(w, http.StatusBadRequest, "bad_policy", "policy must be none, read, suggest or edit")
		return
	}
	id := identityFrom(r.Context())
	if err := s.store.SetAgentPolicyWithEvent(r.Context(), n.ID, req.Policy,
		id.event(n.ID, "agent_policy", map[string]any{"policy": string(req.Policy)})); err != nil {
		internalError(w, err)
		return
	}
	s.respondPermissions(w, r, n)
}

func (s *Server) handleCreateShareLink(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Full)
	if !ok {
		return
	}
	var req struct {
		Label string `json:"label"`
	}
	if r.ContentLength != 0 && !readJSON(w, r, &req) {
		return
	}
	id := identityFrom(r.Context())
	link, err := s.store.CreateShareLink(r.Context(), n.ID, req.Label, id.UserID(),
		id.event(n.ID, "share_link.create", map[string]any{"label": req.Label}))
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"link": link, "url": s.baseURL(r) + "/v/" + link.Token})
}

func (s *Server) handleDeleteShareLink(w http.ResponseWriter, r *http.Request) {
	n, _, ok := s.noteFor(w, r, permission.Full)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	err := s.store.DeleteShareLink(r.Context(), n.ID, r.PathValue("id"), id.event(n.ID, "share_link.revoke", nil))
	if err != nil {
		s.writeNoteError(w, err)
		return
	}
	s.respondPermissions(w, r, n)
}

func (s *Server) handleSearchUsers(w http.ResponseWriter, r *http.Request) {
	if identityFrom(r.Context()) == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
		return
	}
	users, err := s.store.SearchUsers(r.Context(), r.URL.Query().Get("q"), 20)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

// handleResolveShare turns a short view-only link, /v/<token>, into the note it opens.
func (s *Server) handleResolveShare(w http.ResponseWriter, r *http.Request) {
	noteID, err := s.store.ShareLinkNote(r.Context(), r.PathValue("token"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "this link does not exist or was revoked")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	n, err := s.store.NoteByID(r.Context(), noteID)
	if err != nil || n.DeletedAt != "" {
		writeError(w, http.StatusNotFound, "not_found", "this link does not exist or was revoked")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"alias": n.PrimaryAlias})
}
