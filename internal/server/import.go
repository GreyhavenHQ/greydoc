package server

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

// NoteSpec is a new note, from the editor, the API or an importer.
type NoteSpec struct {
	Content string `json:"content"`
	// Alias keeps a note's address, for example a HedgeDoc note ID. Lookups ignore case.
	Alias        string          `json:"alias,omitempty"`
	ExtraAliases []string        `json:"extra_aliases,omitempty"`
	CreatedAt    string          `json:"created_at,omitempty"`
	UpdatedAt    string          `json:"updated_at,omitempty"`
	Permissions  *PermissionSpec `json:"permissions,omitempty"`
	AgentPolicy  string          `json:"agent_policy,omitempty"`
	// Folder is the id of the folder to create the note in. The note then starts with no grants of its own.
	Folder string `json:"folder,omitempty"`
}

// PermissionSpec sets a new note's grants: a HedgeDoc 1 mode, explicit grants, or both (explicit wins).
type PermissionSpec struct {
	HedgeDocMode string            `json:"hedgedoc_mode,omitempty"`
	Everyone     string            `json:"everyone,omitempty"`
	SignedIn     string            `json:"signed_in,omitempty"`
	Users        map[string]string `json:"users,omitempty"`
	// Groups maps greydoc group names to levels.
	Groups map[string]string `json:"groups,omitempty"`
}

var errBadSpec = errors.New("invalid document settings")

func badSpec(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errBadSpec, fmt.Sprintf(format, args...))
}

// hedgedocModes maps HedgeDoc 1 permission modes to (anyone with the address, signed-in users). The owner always edits.
var hedgedocModes = map[string][2]permission.Level{
	"freely":    {permission.Write, permission.Write},
	"editable":  {permission.Read, permission.Write},
	"limited":   {permission.Deny, permission.Write},
	"locked":    {permission.Read, permission.Read},
	"protected": {permission.Deny, permission.Read},
	"private":   {permission.Deny, permission.Deny},
}

func HedgeDocMode(mode string) (everyone, signedIn permission.Level, ok bool) {
	m, ok := hedgedocModes[strings.ToLower(mode)]
	return m[0], m[1], ok
}

// grantLevel reads a level name. HedgeDoc 2 words are accepted: view and edit.
func grantLevel(s string) (permission.Level, error) {
	switch strings.ToLower(s) {
	case "view":
		return permission.Read, nil
	case "edit":
		return permission.Write, nil
	}
	l, ok := permission.ParseLevel(strings.ToLower(s))
	if !ok || l == permission.Full {
		return 0, badSpec("level %q must be deny, read, comment or write", s)
	}
	return l, nil
}

func specTime(s string) (string, error) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return store.FormatTime(t), nil
		}
	}
	return "", badSpec("date %q is not RFC 3339, for example 2021-03-04T10:00:00Z", s)
}

func (s *Server) noteFromSpec(ctx context.Context, id *Identity, spec NoteSpec) (store.NewNote, error) {
	nn := store.NewNote{OwnerID: id.UserID(), Alias: spec.Alias, ExtraAliases: spec.ExtraAliases, Groups: map[string]permission.Level{},
		FolderID: spec.Folder}
	if spec.Folder == "" {
		for g, l := range s.defaultGroups {
			nn.Groups[g] = l
		}
	}
	var err error
	if spec.CreatedAt != "" {
		if nn.CreatedAt, err = specTime(spec.CreatedAt); err != nil {
			return nn, err
		}
	}
	if spec.UpdatedAt != "" {
		if nn.UpdatedAt, err = specTime(spec.UpdatedAt); err != nil {
			return nn, err
		}
		if nn.CreatedAt == "" {
			return nn, badSpec("updated_at needs created_at")
		}
	} else {
		nn.UpdatedAt = nn.CreatedAt
	}
	if nn.UpdatedAt < nn.CreatedAt {
		return nn, badSpec("updated_at is before created_at")
	}
	if p := spec.Permissions; p != nil {
		if p.HedgeDocMode != "" {
			everyone, signedIn, ok := HedgeDocMode(p.HedgeDocMode)
			if !ok {
				return nn, badSpec("hedgedoc_mode %q must be freely, editable, limited, locked, protected or private", p.HedgeDocMode)
			}
			nn.Groups[store.GroupEveryone], nn.Groups[store.GroupSignedIn] = everyone, signedIn
		}
		if p.Everyone != "" {
			if nn.Groups[store.GroupEveryone], err = grantLevel(p.Everyone); err != nil {
				return nn, err
			}
		}
		if p.SignedIn != "" {
			if nn.Groups[store.GroupSignedIn], err = grantLevel(p.SignedIn); err != nil {
				return nn, err
			}
		}
		for name, lv := range p.Groups {
			g, err := s.store.GroupByName(ctx, name)
			if errors.Is(err, store.ErrNotFound) {
				return nn, badSpec("unknown group %q", name)
			}
			if err != nil {
				return nn, err
			}
			if !canUseGroup(id, g) {
				return nn, badSpec("group %q: you can only share with groups you belong to", name)
			}
			if nn.Groups[g.ID], err = grantLevel(lv); err != nil {
				return nn, err
			}
		}
		if len(p.Users) > 0 {
			nn.Users = map[string]permission.Level{}
		}
		for name, lv := range p.Users {
			u, err := s.store.UserByUsername(ctx, name)
			if err != nil {
				return nn, badSpec("unknown user %q", name)
			}
			if nn.Users[u.ID], err = grantLevel(lv); err != nil {
				return nn, err
			}
		}
	}
	nn.Groups[store.GroupEveryone] = min(nn.Groups[store.GroupEveryone], s.guestMax)
	data := map[string]any{}
	if nn.CreatedAt != "" {
		data["imported"] = true
		data["original_created_at"] = nn.CreatedAt
	}
	nn.Event = id.event("", "note.create", data)
	if spec.AgentPolicy != "" && !store.AgentPolicy(spec.AgentPolicy).Valid() {
		return nn, badSpec("agent_policy must be none, read, suggest or edit")
	}
	nn.AgentPolicy = store.AgentPolicy(spec.AgentPolicy)
	// A note an agent creates is its working space: it may edit it. A person's note starts at suggest.
	if nn.AgentPolicy == "" && id.isAgent() {
		nn.AgentPolicy = store.AgentEdit
	}
	return nn, nil
}
