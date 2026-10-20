package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

const maxFolderName = 200

func folderName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxFolderName {
		return "", errors.New("a folder name must have 1 to 200 characters")
	}
	return name, nil
}

type folderRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// folderPath returns the folders above f that the caller can read, root first.
func (s *Server) folderPath(ctx context.Context, id *Identity, parentID string) ([]folderRef, error) {
	path := []folderRef{}
	if parentID == "" {
		return path, nil
	}
	chain, err := s.store.FolderChain(ctx, parentID)
	if err != nil {
		return nil, err
	}
	// A readable folder makes every folder below it readable, so the path starts at the first readable one.
	for i := range chain {
		l, err := s.folderLevel(ctx, id, &chain[i])
		if err != nil {
			return nil, err
		}
		if l >= permission.Read {
			for _, f := range chain[i:] {
				path = append(path, folderRef{f.ID, f.Name})
			}
			break
		}
	}
	return path, nil
}

func (s *Server) handleListFolders(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in to list folders")
		return
	}
	scope := store.Scope(r.URL.Query().Get("scope"))
	if scope != store.ScopeShared {
		scope = store.ScopeMine
	}
	folders, err := s.store.ListFolders(r.Context(), store.FolderFilter{Viewer: s.viewer(id), Scope: scope})
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"folders": folders})
}

func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in to create folders")
		return
	}
	if id.isAgent() {
		writeError(w, http.StatusForbidden, "forbidden", "agents cannot create folders")
		return
	}
	var req struct {
		Name   string `json:"name"`
		Parent string `json:"parent"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	name, err := folderName(req.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_name", err.Error())
		return
	}
	nf := store.NewFolder{Name: name, OwnerID: id.UserID(), ParentID: req.Parent}
	if req.Parent != "" {
		if _, _, err := s.liveFolder(r.Context(), id, req.Parent, permission.Write); err != nil {
			s.writeFolderError(w, r, err)
			return
		}
	} else {
		nf.Groups = s.defaultGroups
	}
	nf.Event = id.event("", "folder.create", map[string]any{"name": name})
	f, err := s.store.CreateFolder(r.Context(), nf)
	if err != nil {
		s.writeFolderError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"folder": f, "level": permission.Full})
}

func (s *Server) handleGetFolder(w http.ResponseWriter, r *http.Request) {
	f, l, ok := s.folderFor(w, r, permission.Read)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	path, err := s.folderPath(r.Context(), id, f.ParentID)
	if err != nil {
		internalError(w, err)
		return
	}
	children, err := s.store.ListFolders(r.Context(), store.FolderFilter{Viewer: s.viewer(id), Parent: f.ID})
	if err != nil {
		internalError(w, err)
		return
	}
	v := map[string]any{"folder": f, "level": l, "path": path, "children": children, "root_owner_id": f.OwnerID}
	if len(path) > 0 {
		if top, err := s.store.FolderByID(r.Context(), path[0].ID); err == nil {
			v["root_owner_id"] = top.OwnerID
		}
	}
	if f.OwnerID != "" {
		v["owner"], _ = s.store.UserByID(r.Context(), f.OwnerID)
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleRenameFolder(w http.ResponseWriter, r *http.Request) {
	f, _, ok := s.folderFor(w, r, permission.Write)
	if !ok {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	name, err := folderName(req.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_name", err.Error())
		return
	}
	id := identityFrom(r.Context())
	if err := s.store.RenameFolder(r.Context(), f.ID, name, id.event(f.ID, "folder.rename", map[string]any{"from": f.Name, "to": name})); err != nil {
		s.writeFolderError(w, r, err)
		return
	}
	f.Name = name
	writeJSON(w, http.StatusOK, map[string]any{"folder": f})
}

// recheckFolder makes open editors of every note below a folder check their access again.
func (s *Server) recheckFolder(ctx context.Context, folderID string) {
	if s.hub == nil {
		return
	}
	ids, err := s.store.SubtreeNoteIDs(ctx, folderID)
	if err != nil {
		return
	}
	for _, noteID := range ids {
		s.hub.PermissionsChanged(noteID)
	}
}

type inheritedGrants struct {
	FolderID   string             `json:"folder_id"`
	FolderName string             `json:"folder_name"`
	Owner      *store.User        `json:"owner"`
	Users      []store.UserGrant  `json:"users"`
	Groups     []store.GroupGrant `json:"groups"`
}

// inherited lists the grants of folderID and the folders above it, nearest first.
func (s *Server) inherited(ctx context.Context, folderID string) ([]inheritedGrants, error) {
	out := []inheritedGrants{}
	if folderID == "" {
		return out, nil
	}
	chain, err := s.store.FolderChain(ctx, folderID)
	if err != nil {
		return nil, err
	}
	for i := len(chain) - 1; i >= 0; i-- {
		f := chain[i]
		acl, err := s.store.FolderACL(ctx, f.ID)
		if err != nil {
			return nil, err
		}
		g := inheritedGrants{FolderID: f.ID, FolderName: f.Name, Users: acl.Users, Groups: acl.Groups}
		if f.OwnerID != "" {
			g.Owner, _ = s.store.UserByID(ctx, f.OwnerID)
		}
		out = append(out, g)
	}
	return out, nil
}

type folderPermissionsView struct {
	Owner     *store.User        `json:"owner"`
	Users     []store.UserGrant  `json:"users"`
	Groups    []store.GroupGrant `json:"groups"`
	Inherited []inheritedGrants  `json:"inherited"`
	GuestMax  permission.Level   `json:"guest_max"`
}

func (s *Server) folderPermissionsView(ctx context.Context, f *store.Folder, l permission.Level) (*folderPermissionsView, error) {
	acl, err := s.store.FolderACL(ctx, f.ID)
	if err != nil {
		return nil, err
	}
	v := &folderPermissionsView{Users: acl.Users, Groups: acl.Groups, GuestMax: s.guestMax, Inherited: []inheritedGrants{}}
	if acl.OwnerID != "" {
		v.Owner, _ = s.store.UserByID(ctx, acl.OwnerID)
	}
	if l < permission.Full {
		v.Users, v.Groups = []store.UserGrant{}, publicGroups(v.Groups)
		return v, nil
	}
	if v.Inherited, err = s.inherited(ctx, f.ParentID); err != nil {
		return nil, err
	}
	return v, nil
}

func publicGroups(groups []store.GroupGrant) []store.GroupGrant {
	public := []store.GroupGrant{}
	for _, g := range groups {
		if g.Group == store.GroupEveryone || g.Group == store.GroupSignedIn {
			public = append(public, g)
		}
	}
	return public
}

func (s *Server) handleGetFolderPermissions(w http.ResponseWriter, r *http.Request) {
	f, l, ok := s.folderFor(w, r, permission.Read)
	if !ok {
		return
	}
	v, err := s.folderPermissionsView(r.Context(), f, l)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) respondFolderPermissions(w http.ResponseWriter, r *http.Request, f *store.Folder) {
	s.recheckFolder(r.Context(), f.ID)
	v, err := s.folderPermissionsView(r.Context(), f, permission.Full)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleFolderUserGrant(w http.ResponseWriter, r *http.Request) {
	f, _, ok := s.folderFor(w, r, permission.Full)
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
	ev := id.event(f.ID, "folder.permission.user", map[string]any{"folder": f.Name, "username": u.Username, "level": l.String()})
	if err := s.store.SetFolderUserGrant(r.Context(), f.ID, u.ID, l, ev); err != nil {
		internalError(w, err)
		return
	}
	s.respondFolderPermissions(w, r, f)
}

func (s *Server) handleFolderGroupGrant(w http.ResponseWriter, r *http.Request) {
	f, _, ok := s.folderFor(w, r, permission.Full)
	if !ok {
		return
	}
	l, ok := parseGrantLevel(w, r)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	group := r.PathValue("group")
	data, ok := s.checkGroup(w, r, id, group, l)
	if !ok {
		return
	}
	data["folder"] = f.Name
	ev := id.event(f.ID, "folder.permission.group", data)
	if err := s.store.SetFolderGroupGrant(r.Context(), f.ID, group, l, ev); err != nil {
		internalError(w, err)
		return
	}
	s.respondFolderPermissions(w, r, f)
}

// canTrashFolder: the folder owner or an admin, never an agent.
func (s *Server) canTrashFolder(id *Identity, f *store.Folder) bool {
	if id == nil || id.isAgent() {
		return false
	}
	return id.Local || id.Admin || (f.OwnerID != "" && f.OwnerID == id.UserID())
}

// anyFolder loads the {id} folder, in the trash or not, for trash, restore and purge.
func (s *Server) anyFolder(w http.ResponseWriter, r *http.Request) (*store.Folder, bool) {
	id := identityFrom(r.Context())
	f, err := s.store.FolderByID(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) || (err == nil && !s.canTrashFolder(id, f)) {
		if id == nil {
			writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
		} else {
			writeError(w, http.StatusNotFound, "not_found", "no such folder, or you do not own it")
		}
		return nil, false
	}
	if err != nil {
		internalError(w, err)
		return nil, false
	}
	return f, true
}

func (s *Server) handleDeleteFolder(w http.ResponseWriter, r *http.Request) {
	f, ok := s.anyFolder(w, r)
	if !ok {
		return
	}
	id := identityFrom(r.Context())
	if r.URL.Query().Get("permanent") == "1" {
		if f.DeletedAt == "" {
			writeError(w, http.StatusConflict, "not_in_trash", "move the folder to the trash first")
			return
		}
		if err := s.purgeFolder(r.Context(), id.event(f.ID, "folder.delete", map[string]any{"name": f.Name}), f); err != nil {
			internalError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if f.DeletedAt != "" {
		writeError(w, http.StatusGone, "in_trash", "this folder is already in the trash")
		return
	}
	trashed, detached, err := s.store.TrashFolder(r.Context(), f.ID, id.displayName(), id.event(f.ID, "folder.trash", map[string]any{"name": f.Name}))
	if err != nil {
		internalError(w, err)
		return
	}
	for _, noteID := range trashed {
		s.hub.CloseNote(noteID, "trashed")
	}
	for _, noteID := range detached {
		s.hub.PermissionsChanged(noteID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"trashed": len(trashed), "moved_out": len(detached)})
}

func (s *Server) handleRestoreFolder(w http.ResponseWriter, r *http.Request) {
	f, ok := s.anyFolder(w, r)
	if !ok {
		return
	}
	if f.DeletedAt == "" {
		writeError(w, http.StatusConflict, "not_in_trash", "this folder is not in the trash")
		return
	}
	id := identityFrom(r.Context())
	err := s.store.RestoreFolder(r.Context(), f.ID, id.event(f.ID, "folder.restore", map[string]any{"name": f.Name}))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "not_in_trash", "restore the folder that was moved to the trash")
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": f.ID})
}

// purgeFolder deletes a trashed folder for good, with the notes trashed with it.
func (s *Server) purgeFolder(ctx context.Context, ev *store.Event, f *store.Folder) error {
	ids, err := s.store.FolderTrashNotes(ctx, f.ID)
	if err != nil {
		return err
	}
	for _, noteID := range ids {
		n, err := s.store.NoteByID(ctx, noteID)
		if err != nil {
			continue
		}
		if err := s.purgeNote(ctx, &store.Event{NoteID: n.ID, ActorID: ev.ActorID, ActorName: ev.ActorName, Source: ev.Source,
			Kind: "note.delete", Data: map[string]any{"alias": n.PrimaryAlias, "title": n.Title, "folder": f.Name}}, n); err != nil {
			return err
		}
	}
	if err := s.store.PurgeFolder(ctx, f.ID); err != nil {
		return err
	}
	return s.store.AddEvent(ctx, ev)
}

type moveRequest struct {
	Notes   []string `json:"notes"`
	Folders []string `json:"folders"`
	// To is the destination folder id. Empty means the top level.
	To     string `json:"to"`
	DryRun bool   `json:"dry_run"`
}

// accessChange is how one person or group's access to a moved item changes.
type accessChange struct {
	Item   string           `json:"item"`
	Who    string           `json:"who"`
	Kind   string           `json:"kind"`
	Before permission.Level `json:"before"`
	After  permission.Level `json:"after"`
}

type moveItem struct {
	note   *store.Note
	folder *store.Folder
}

func (m moveItem) name() string {
	if m.note != nil {
		if m.note.Title != "" {
			return m.note.Title
		}
		return m.note.PrimaryAlias
	}
	return m.folder.Name
}

func (s *Server) handleMove(w http.ResponseWriter, r *http.Request) {
	id := identityFrom(r.Context())
	if id == nil {
		writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
		return
	}
	var req moveRequest
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.Notes)+len(req.Folders) == 0 || len(req.Notes)+len(req.Folders) > 500 {
		writeError(w, http.StatusBadRequest, "bad_request", "move 1 to 500 items")
		return
	}
	ctx := r.Context()
	var dest *store.Folder
	if req.To != "" {
		var err error
		if dest, _, err = s.liveFolder(ctx, id, req.To, permission.Write); err != nil {
			s.writeFolderError(w, r, err)
			return
		}
	}
	items, msg, err := s.moveItems(ctx, id, req)
	if err != nil {
		internalError(w, err)
		return
	}
	if msg != "" {
		writeError(w, http.StatusForbidden, "forbidden", msg)
		return
	}
	if req.DryRun {
		changes := []accessChange{}
		for _, it := range items {
			c, err := s.accessChanges(ctx, it, req.To)
			if err != nil {
				internalError(w, err)
				return
			}
			changes = append(changes, c...)
		}
		writeJSON(w, http.StatusOK, map[string]any{"changes": changes})
		return
	}
	to := ""
	if dest != nil {
		to = dest.Name
	}
	for _, it := range items {
		if err := s.moveItem(ctx, id, it, req.To, to); err != nil {
			s.writeFolderError(w, r, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"moved": len(items)})
}

// moveItems loads every item and checks the caller may move it. msg explains the first refusal.
func (s *Server) moveItems(ctx context.Context, id *Identity, req moveRequest) (items []moveItem, msg string, err error) {
	owns := func(owner string) bool { return id.Local || (owner != "" && owner == id.UserID()) }
	for _, alias := range req.Notes {
		n, err := s.store.NoteByAlias(ctx, alias)
		if errors.Is(err, store.ErrNotFound) || (err == nil && n.DeletedAt != "") {
			return nil, "no document " + alias, nil
		}
		if err != nil {
			return nil, "", err
		}
		if !owns(n.OwnerID) {
			return nil, "only the owner can move “" + moveItem{note: n}.name() + "”", nil
		}
		if id.isAgent() && (n.AgentPolicy != store.AgentEdit || !id.canWriteScope()) {
			return nil, "agents can move a document only for its owner, with agent policy \"edit\"", nil
		}
		items = append(items, moveItem{note: n})
	}
	for _, fid := range req.Folders {
		f, err := s.store.FolderByID(ctx, fid)
		if errors.Is(err, store.ErrNotFound) || (err == nil && f.DeletedAt != "") {
			return nil, "no such folder", nil
		}
		if err != nil {
			return nil, "", err
		}
		if !owns(f.OwnerID) || id.isAgent() {
			return nil, "only the owner can move the folder “" + f.Name + "”", nil
		}
		items = append(items, moveItem{folder: f})
	}
	return items, "", nil
}

func (s *Server) moveItem(ctx context.Context, id *Identity, it moveItem, to, toName string) error {
	if n := it.note; n != nil {
		if n.FolderID == to {
			return nil
		}
		from := ""
		if n.FolderID != "" {
			if f, err := s.store.FolderByID(ctx, n.FolderID); err == nil {
				from = f.Name
			}
		}
		ev := id.event(n.ID, "note.move", map[string]any{"from": from, "to": toName})
		if err := s.store.MoveNote(ctx, n.ID, to, ev); err != nil {
			return err
		}
		s.hub.PermissionsChanged(n.ID)
		return nil
	}
	f := it.folder
	if f.ParentID == to && to != f.ID {
		return nil
	}
	if err := s.store.MoveFolder(ctx, f.ID, to, id.event(f.ID, "folder.move", map[string]any{"folder": f.Name, "to": toName})); err != nil {
		return err
	}
	s.recheckFolder(ctx, f.ID)
	return nil
}

// grantMap is the access each person or group gets on an item, keyed by "user:<id>" or "group:<name>".
type grantMap map[string]struct {
	label string
	kind  string
	level permission.Level
}

func (g grantMap) add(key, label, kind string, l permission.Level) {
	if cur, ok := g[key]; ok && cur.level >= l {
		return
	}
	g[key] = struct {
		label string
		kind  string
		level permission.Level
	}{label, kind, l}
}

func (g grantMap) addACL(acl *store.ACL) {
	for _, u := range acl.Users {
		label := u.DisplayName
		if label == "" {
			label = u.Username
		}
		g.add("user:"+u.UserID, label, "user", u.Level)
	}
	for _, gr := range acl.Groups {
		label := gr.Group
		if gr.Name != "" {
			label = gr.Name
		}
		g.add("group:"+gr.Group, label, "group", gr.Level)
	}
}

func (s *Server) chainGrants(ctx context.Context, g grantMap, folderID, itemOwner string) error {
	if folderID == "" {
		return nil
	}
	chain, err := s.store.FolderChain(ctx, folderID)
	if err != nil {
		return err
	}
	for _, f := range chain {
		acl, err := s.store.FolderACL(ctx, f.ID)
		if err != nil {
			return err
		}
		g.addACL(acl)
		if f.OwnerID != "" && f.OwnerID != itemOwner {
			label := f.OwnerID
			if u, err := s.store.UserByID(ctx, f.OwnerID); err == nil {
				label = u.DisplayName
				if label == "" {
					label = u.Username
				}
			}
			g.add("user:"+f.OwnerID, label, "user", permission.Write)
		}
	}
	return nil
}

// accessChanges compares who can open the item now and after a move to dest.
func (s *Server) accessChanges(ctx context.Context, it moveItem, dest string) ([]accessChange, error) {
	var own *store.ACL
	var err error
	var parent, owner string
	if it.note != nil {
		own, err = s.store.NoteACL(ctx, it.note.ID)
		parent, owner = it.note.FolderID, it.note.OwnerID
	} else {
		own, err = s.store.FolderACL(ctx, it.folder.ID)
		parent, owner = it.folder.ParentID, it.folder.OwnerID
	}
	if err != nil {
		return nil, err
	}
	before, after := grantMap{}, grantMap{}
	before.addACL(own)
	after.addACL(own)
	if err := s.chainGrants(ctx, before, parent, owner); err != nil {
		return nil, err
	}
	if err := s.chainGrants(ctx, after, dest, owner); err != nil {
		return nil, err
	}
	out := []accessChange{}
	for key, b := range before {
		if a := after[key]; a.level != b.level {
			out = append(out, accessChange{Item: it.name(), Who: b.label, Kind: b.kind, Before: b.level, After: a.level})
		}
	}
	for key, a := range after {
		if _, ok := before[key]; !ok {
			out = append(out, accessChange{Item: it.name(), Who: a.label, Kind: a.kind, Before: permission.Deny, After: a.level})
		}
	}
	return out, nil
}
