package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// isAgent reports whether the caller is a program (MCP client, token) rather than a browser.
func (id *Identity) isAgent() bool {
	return id != nil && (id.Via == "token" || id.Via == "oauth" || id.Via == "mcp")
}

func (id *Identity) source() store.Source {
	if id.isAgent() {
		return store.SourceAgent
	}
	return store.SourceHuman
}

func (id *Identity) displayName() string {
	if id == nil || id.User == nil {
		return "guest"
	}
	if id.User.DisplayName != "" {
		return id.User.DisplayName
	}
	return id.User.Username
}

// event prefills actor fields for an audit event.
func (id *Identity) event(noteID, kind string, data map[string]any) *store.Event {
	ev := &store.Event{NoteID: noteID, ActorName: id.displayName(), Source: id.source(), Kind: kind, Data: data}
	if id != nil {
		ev.ActorID = id.UserID()
		ev.Client = id.Client
	}
	return ev
}

// noteLevel computes the caller's level on a note. Agents are capped by the note's agent policy.
func (s *Server) noteLevel(ctx context.Context, id *Identity, n *store.Note, shareToken string) (permission.Level, error) {
	in := permission.Input{Local: id != nil && id.Local, MaxGuest: s.guestMax}
	if id != nil && id.User != nil {
		in.IsRegistered = true
		in.IsOwner = n.OwnerID != "" && n.OwnerID == id.User.ID
	}
	if !in.Local && !in.IsOwner {
		acl, err := s.store.NoteACL(ctx, n.ID)
		if err != nil {
			return permission.Deny, err
		}
		applyACL(&in, id, acl)
		if n.FolderID != "" {
			if err := s.applyFolderChain(ctx, &in, id, n.FolderID); err != nil {
				return permission.Deny, err
			}
		}
		if shareToken != "" {
			ok, err := s.store.ShareLinkValid(ctx, n.ID, shareToken)
			if err != nil {
				return permission.Deny, err
			}
			in.ShareLink = ok
		}
	}
	l := permission.Determine(in)
	if id.isAgent() {
		l = permission.AgentLevel(l, permission.Policy(n.AgentPolicy))
	}
	if !id.canWriteScope() {
		l = min(l, permission.Read)
	}
	return l, nil
}

// withFreshGroups reloads the caller's groups, for long-lived connections that outlive a membership change.
func (s *Server) withFreshGroups(ctx context.Context, id *Identity) (*Identity, error) {
	if id == nil || id.User == nil || id.Local {
		return id, nil
	}
	ids, err := s.store.UserGroupIDs(ctx, id.User.ID)
	if err != nil {
		return nil, err
	}
	c, u := *id, *id.User
	u.GroupIDs = ids
	c.User = &u
	return &c, nil
}

// applyACL raises the input to the grants in acl that match the caller.
func applyACL(in *permission.Input, id *Identity, acl *store.ACL) {
	for _, g := range acl.Users {
		if in.IsRegistered && g.UserID == id.User.ID {
			in.User = max(in.User, g.Level)
		}
	}
	for _, g := range acl.Groups {
		switch g.Group {
		case store.GroupEveryone:
			in.Everyone = max(in.Everyone, g.Level)
		case store.GroupSignedIn:
			in.LoggedIn = max(in.LoggedIn, g.Level)
		default:
			if in.IsRegistered && slices.Contains(id.User.GroupIDs, g.Group) {
				in.Group = max(in.Group, g.Level)
			}
		}
	}
}

// applyFolderChain adds the grants of folderID and every folder above it.
func (s *Server) applyFolderChain(ctx context.Context, in *permission.Input, id *Identity, folderID string) error {
	chain, err := s.store.FolderChain(ctx, folderID)
	if err != nil {
		return err
	}
	for _, f := range chain {
		if in.IsRegistered && f.OwnerID != "" && f.OwnerID == id.User.ID {
			in.FolderOwner = true
		}
		acl, err := s.store.FolderACL(ctx, f.ID)
		if err != nil {
			return err
		}
		applyACL(in, id, acl)
	}
	return nil
}

// folderLevel computes the caller's level on a folder from its grants and those of the folders above it.
func (s *Server) folderLevel(ctx context.Context, id *Identity, f *store.Folder) (permission.Level, error) {
	in := permission.Input{Local: id != nil && id.Local, MaxGuest: s.guestMax}
	if id != nil && id.User != nil {
		in.IsRegistered = true
		in.IsOwner = f.OwnerID != "" && f.OwnerID == id.User.ID
	}
	if !in.Local && !in.IsOwner {
		acl, err := s.store.FolderACL(ctx, f.ID)
		if err != nil {
			return permission.Deny, err
		}
		applyACL(&in, id, acl)
		if f.ParentID != "" {
			if err := s.applyFolderChain(ctx, &in, id, f.ParentID); err != nil {
				return permission.Deny, err
			}
		}
	}
	l := permission.Determine(in)
	if !id.canWriteScope() {
		l = min(l, permission.Read)
	}
	return l, nil
}

// folderFor loads the {id} folder and checks the caller has at least need. It writes the error response itself.
func (s *Server) folderFor(w http.ResponseWriter, r *http.Request, need permission.Level) (*store.Folder, permission.Level, bool) {
	f, l, err := s.liveFolder(r.Context(), identityFrom(r.Context()), r.PathValue("id"), need)
	if err != nil {
		s.writeFolderError(w, r, err)
		return nil, l, false
	}
	return f, l, true
}

var (
	errFolderMissing = errors.New("no such folder")
	errFolderTrashed = errors.New("this folder is in the trash")
)

type levelError struct {
	have, need permission.Level
}

func (e *levelError) Error() string {
	if e.have == permission.Deny {
		return "you do not have access to this folder"
	}
	return "this action needs " + e.need.String() + " access to the folder"
}

func (s *Server) liveFolder(ctx context.Context, id *Identity, folderID string, need permission.Level) (*store.Folder, permission.Level, error) {
	f, err := s.store.FolderByID(ctx, folderID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, 0, errFolderMissing
	}
	if err != nil {
		return nil, 0, err
	}
	l, err := s.folderLevel(ctx, id, f)
	if err != nil {
		return nil, 0, err
	}
	if l == permission.Deny {
		// A folder the caller cannot see does not exist for them.
		return nil, l, errFolderMissing
	}
	if f.DeletedAt != "" {
		return nil, l, errFolderTrashed
	}
	if l < need {
		return nil, l, &levelError{l, need}
	}
	return f, l, nil
}

func (s *Server) writeFolderError(w http.ResponseWriter, r *http.Request, err error) {
	var le *levelError
	switch {
	case errors.Is(err, errFolderMissing):
		if identityFrom(r.Context()) == nil {
			writeError(w, http.StatusUnauthorized, "login_required", "sign in first")
			return
		}
		writeError(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, errFolderTrashed):
		writeError(w, http.StatusGone, "in_trash", err.Error())
	case errors.As(err, &le):
		writeError(w, http.StatusForbidden, "forbidden", err.Error())
	case errors.Is(err, store.ErrFolderCycle), errors.Is(err, store.ErrFolderDepth):
		writeError(w, http.StatusBadRequest, "bad_move", err.Error())
	default:
		internalError(w, err)
	}
}

func shareToken(r *http.Request) string {
	if t := r.Header.Get("X-Share-Token"); t != "" {
		return t
	}
	return r.URL.Query().Get("share")
}

// noteFor loads the {alias} note and checks the caller has at least need. It writes the error response itself.
func (s *Server) noteFor(w http.ResponseWriter, r *http.Request, need permission.Level) (*store.Note, permission.Level, bool) {
	n, err := s.store.NoteByAlias(r.Context(), r.PathValue("alias"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "no such document")
		return nil, 0, false
	}
	if err != nil {
		internalError(w, err)
		return nil, 0, false
	}
	if n.DeletedAt != "" {
		writeError(w, http.StatusGone, "in_trash", "this document is in the trash")
		return nil, 0, false
	}
	id := identityFrom(r.Context())
	l, err := s.noteLevel(r.Context(), id, n, shareToken(r))
	if err != nil {
		internalError(w, err)
		return nil, 0, false
	}
	if l < need {
		if l == permission.Deny && id == nil {
			w.Header().Set("WWW-Authenticate", s.wwwAuthenticate(r))
			writeError(w, http.StatusUnauthorized, "login_required", "sign in to open this document")
		} else if l == permission.Deny {
			writeError(w, http.StatusForbidden, "forbidden", "you do not have access to this document")
		} else {
			writeError(w, http.StatusForbidden, "forbidden", "this action needs "+need.String()+" access")
		}
		return nil, l, false
	}
	return n, l, true
}

var errNotOwner = errors.New("only the owner can move this document to the trash or restore it")

// canTrash decides who may trash, restore or purge a note: its owner, or an admin. An agent also needs the edit policy.
func (s *Server) canTrash(id *Identity, n *store.Note) error {
	if id == nil {
		return errNotOwner
	}
	owner := id.Local || (n.OwnerID != "" && n.OwnerID == id.UserID())
	if id.isAgent() {
		if !owner || n.AgentPolicy != store.AgentEdit {
			return fmt.Errorf("agents can trash or restore a document only for its owner, with agent policy \"edit\" (this document: %q)", n.AgentPolicy)
		}
		if !id.canWriteScope() {
			return errors.New("this token can only read")
		}
		return nil
	}
	if owner || id.Admin {
		return nil
	}
	return errNotOwner
}
