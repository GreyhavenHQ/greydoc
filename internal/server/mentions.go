package server

import (
	"context"
	"log/slog"
	"slices"
	"strings"

	"github.com/greyhavenhq/greydoc/internal/notemeta"
	"github.com/greyhavenhq/greydoc/internal/permission"
	"github.com/greyhavenhq/greydoc/internal/store"
)

const (
	mentionDocument   = "document"
	mentionComment    = "comment"
	mentionSuggestion = "suggestion"
)

// mentionedUsers resolves the mentions in text to known users.
func (s *Server) mentionedUsers(ctx context.Context, text string) ([]store.User, error) {
	names := notemeta.Mentions(text)
	if len(names) == 0 {
		return nil, nil
	}
	return s.store.UsersByUsername(ctx, names)
}

func (s *Server) canRead(ctx context.Context, u store.User, n *store.Note) bool {
	id, err := s.withFreshGroups(ctx, &Identity{User: &u, Via: "session"})
	if err != nil {
		return false
	}
	l, err := s.noteLevel(ctx, id, n, "")
	return err == nil && l >= permission.Read
}

// notifyMentions notifies the readers of n that text mentions, except the actor.
func (s *Server) notifyMentions(ctx context.Context, id *Identity, n *store.Note, kind, ref, text string) {
	if s.cfg.LocalMode() {
		return
	}
	users, err := s.mentionedUsers(ctx, text)
	if err != nil {
		slog.Warn("mention lookup failed", "note", n.ID, "error", err)
		return
	}
	var out []store.Notification
	for _, u := range users {
		if u.ID == id.UserID() || !s.canRead(ctx, u, n) {
			continue
		}
		out = append(out, store.Notification{UserID: u.ID, NoteID: n.ID, Kind: kind, ActorID: id.UserID(), ActorName: id.displayName(),
			Ref: ref, Excerpt: excerpt(notemeta.MentionsToText(text))})
	}
	if err := s.store.CreateNotifications(ctx, out); err != nil {
		slog.Warn("notification failed", "note", n.ID, "error", err)
	}
}

// rememberMentions records the people an accepted suggestion mentions, who were notified when it was made.
func (s *Server) rememberMentions(ctx context.Context, n *store.Note, text string) {
	if s.cfg.LocalMode() {
		return
	}
	users, err := s.mentionedUsers(ctx, text)
	if err == nil && len(users) > 0 {
		err = s.store.AddMentions(ctx, n.ID, userIDs(users))
	}
	if err != nil {
		slog.Warn("mention record failed", "note", n.ID, "error", err)
	}
}

func userIDs(users []store.User) []string {
	ids := make([]string, len(users))
	for i, u := range users {
		ids[i] = u.ID
	}
	return ids
}

// notifyDocMentions runs after each revision. It notifies the readers that the text mentions for the first time.
func (s *Server) notifyDocMentions(ctx context.Context, noteID, _, text string, authors []store.RevisionAuthor) {
	if err := s.docMentions(ctx, noteID, text, authors); err != nil {
		slog.Warn("document mentions failed", "note", noteID, "error", err)
	}
}

func (s *Server) docMentions(ctx context.Context, noteID, text string, authors []store.RevisionAuthor) error {
	stored, err := s.store.MentionSet(ctx, noteID)
	if err != nil {
		return err
	}
	users, err := s.mentionedUsers(ctx, text)
	if err != nil || (len(users) == 0 && len(stored) == 0) {
		return err
	}
	n, err := s.store.NoteByID(ctx, noteID)
	if err != nil || n.DeletedAt != "" {
		return err
	}
	known := map[string]bool{}
	for _, id := range stored {
		known[id] = true
	}
	actorID, names, wrote := "", []string{}, map[string]bool{}
	for _, a := range authors {
		if a.UserID != "" && actorID == "" {
			actorID = a.UserID
		}
		if a.Name != "" && !slices.Contains(names, a.Name) {
			names = append(names, a.Name)
		}
		wrote[a.UserID] = true
	}
	var out []store.Notification
	for _, u := range users {
		if known[u.ID] || wrote[u.ID] || !s.canRead(ctx, u, n) {
			continue
		}
		out = append(out, store.Notification{UserID: u.ID, NoteID: n.ID, Kind: mentionDocument, ActorID: actorID,
			ActorName: strings.Join(names, ", "), Excerpt: excerpt(notemeta.MentionsToText(mentionLine(text, u.Username)))})
	}
	if err := s.store.CreateNotifications(ctx, out); err != nil {
		return err
	}
	return s.store.ReplaceMentionSet(ctx, noteID, userIDs(users))
}

// mentionLine returns the first line of text that mentions username.
func mentionLine(text, username string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(strings.ToLower(line), "](@"+username+")") {
			return line
		}
	}
	return ""
}
