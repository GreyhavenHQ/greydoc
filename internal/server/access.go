package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"

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
		for _, g := range acl.Users {
			if in.IsRegistered && g.UserID == id.User.ID {
				in.User = g.Level
			}
		}
		for _, g := range acl.Groups {
			switch g.Group {
			case store.GroupEveryone:
				in.Everyone = g.Level
			case store.GroupSignedIn:
				in.LoggedIn = g.Level
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
