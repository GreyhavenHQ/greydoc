package store

import (
	"context"
	"database/sql"
	"strings"

	"github.com/greyhavenhq/greydoc/internal/secrets"
)

type Notification struct {
	ID        string `json:"id"`
	UserID    string `json:"-"`
	NoteID    string `json:"note_id"`
	NoteAlias string `json:"note_alias"`
	NoteTitle string `json:"note_title"`
	Kind      string `json:"kind"`
	ActorID   string `json:"actor_id"`
	ActorName string `json:"actor_name"`
	Ref       string `json:"ref,omitempty"`
	Excerpt   string `json:"excerpt,omitempty"`
	CreatedAt string `json:"created_at"`
	ReadAt    string `json:"read_at,omitempty"`
}

func (s *Store) CreateNotifications(ctx context.Context, ns []Notification) error {
	if len(ns) == 0 {
		return nil
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		for i := range ns {
			n := &ns[i]
			n.ID, n.CreatedAt = secrets.NewID(), Now()
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO notification (id, user_id, note_id, kind, actor_id, actor_name, ref, excerpt, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`), n.ID, n.UserID, n.NoteID, n.Kind, n.ActorID, n.ActorName, n.Ref, n.Excerpt, n.CreatedAt); err != nil {
				return err
			}
		}
		return nil
	})
}

// Notifications lists a user's notifications newest first, without those for notes in the trash.
func (s *Store) Notifications(ctx context.Context, userID string, limit int) ([]Notification, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT x.id, x.note_id, a.name, n.title, x.kind, x.actor_id, x.actor_name, x.ref, x.excerpt,
		x.created_at, COALESCE(x.read_at, '')
		FROM notification x JOIN note n ON n.id = x.note_id JOIN note_alias a ON a.note_id = n.id AND a.is_primary = 1
		WHERE x.user_id = ? AND n.deleted_at IS NULL ORDER BY x.created_at DESC, x.id LIMIT ?`), userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Notification{}
	for rows.Next() {
		n := Notification{UserID: userID}
		if err := rows.Scan(&n.ID, &n.NoteID, &n.NoteAlias, &n.NoteTitle, &n.Kind, &n.ActorID, &n.ActorName, &n.Ref, &n.Excerpt,
			&n.CreatedAt, &n.ReadAt); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (s *Store) UnreadNotifications(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM notification x JOIN note n ON n.id = x.note_id
		WHERE x.user_id = ? AND x.read_at IS NULL AND n.deleted_at IS NULL`), userID).Scan(&n)
	return n, err
}

// MarkNotificationsRead marks the given notifications of a user as read, or all of them when ids is empty.
func (s *Store) MarkNotificationsRead(ctx context.Context, userID string, ids []string) error {
	query := `UPDATE notification SET read_at = ? WHERE user_id = ? AND read_at IS NULL`
	args := []any{Now(), userID}
	if len(ids) > 0 {
		query += " AND id IN (" + strings.TrimSuffix(strings.Repeat("?, ", len(ids)), ", ") + ")"
		for _, id := range ids {
			args = append(args, id)
		}
	}
	_, err := s.db.ExecContext(ctx, s.q(query), args...)
	return err
}

// MentionSet returns the user ids the current text of a note mentions.
func (s *Store) MentionSet(ctx context.Context, noteID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT user_id FROM note_mention WHERE note_id = ? ORDER BY user_id`), noteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) ReplaceMentionSet(ctx context.Context, noteID string, userIDs []string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`DELETE FROM note_mention WHERE note_id = ?`), noteID); err != nil {
			return err
		}
		return s.insertMentions(ctx, tx, noteID, userIDs)
	})
}

func (s *Store) AddMentions(ctx context.Context, noteID string, userIDs []string) error {
	return s.tx(ctx, func(tx *sql.Tx) error { return s.insertMentions(ctx, tx, noteID, userIDs) })
}

func (s *Store) insertMentions(ctx context.Context, tx *sql.Tx, noteID string, userIDs []string) error {
	for _, id := range userIDs {
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO note_mention (note_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING`), noteID, id); err != nil {
			return err
		}
	}
	return nil
}
