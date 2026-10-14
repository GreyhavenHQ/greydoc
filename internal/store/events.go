package store

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/greyhavenhq/greydoc/internal/secrets"
)

// Source says who produced a change: a person, a person with AI help, an agent, or a restore.
type Source string

const (
	SourceHuman      Source = "human"
	SourceAIAssisted Source = "ai_assisted"
	SourceAgent      Source = "agent"
	SourceRestore    Source = "restore"
)

type Event struct {
	ID        string         `json:"id"`
	NoteID    string         `json:"note_id"`
	ActorID   string         `json:"actor_id,omitempty"`
	ActorName string         `json:"actor_name"`
	Source    Source         `json:"source"`
	Client    string         `json:"client,omitempty"`
	Kind      string         `json:"kind"`
	Data      map[string]any `json:"data"`
	CreatedAt string         `json:"created_at"`
}

func (s *Store) insertEvent(ctx context.Context, tx execer, ev *Event) error {
	if ev == nil {
		return nil
	}
	if ev.ID == "" {
		ev.ID = secrets.NewID()
	}
	if ev.CreatedAt == "" {
		ev.CreatedAt = Now()
	}
	if ev.Source == "" {
		ev.Source = SourceHuman
	}
	if ev.Data == nil {
		ev.Data = map[string]any{}
	}
	data, err := json.Marshal(ev.Data)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, s.q(`INSERT INTO audit_event (id, note_id, actor_id, actor_name, source, client, kind, data, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`), ev.ID, ev.NoteID, nullStr(ev.ActorID), ev.ActorName, string(ev.Source),
		ev.Client, ev.Kind, string(data), ev.CreatedAt)
	return err
}

func (s *Store) AddEvent(ctx context.Context, ev *Event) error { return s.insertEvent(ctx, s.db, ev) }

func (s *Store) Events(ctx context.Context, noteID string, limit int) ([]Event, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT id, note_id, COALESCE(actor_id, ''), actor_name, source, client, kind, data, created_at
		FROM audit_event WHERE note_id = ? ORDER BY created_at DESC LIMIT ?`), noteID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var ev Event
		var src, data string
		if err := rows.Scan(&ev.ID, &ev.NoteID, &ev.ActorID, &ev.ActorName, &src, &ev.Client, &ev.Kind, &data, &ev.CreatedAt); err != nil {
			return nil, err
		}
		ev.Source = Source(src)
		_ = json.Unmarshal([]byte(data), &ev.Data)
		out = append(out, ev)
	}
	return out, rows.Err()
}

const SourceSystem Source = "system"

type AuditFilter struct {
	Viewer Viewer
	Kind   string
	Actor  string
	Source string
	NoteID string
	// Before pages backwards through time.
	Before string
	Limit  int
}

type AuditEntry struct {
	Event
	NoteAlias string `json:"note_alias,omitempty"`
	NoteTitle string `json:"note_title,omitempty"`
	// NoteState is live, trash, deleted, or empty for account events.
	NoteState string `json:"note_state,omitempty"`
}

// Audit lists events across notes, newest first. Others see events on notes they can read and their own actions.
func (s *Store) Audit(ctx context.Context, f AuditFilter) ([]AuditEntry, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 100
	}
	where, args := "1 = 1", []any{}
	if !f.Viewer.Local && !f.Viewer.Admin {
		vw, vargs := s.visibleWhere(f.Viewer)
		where = "(e.actor_id = ? OR (n.id IS NOT NULL AND " + vw + "))"
		args = append([]any{f.Viewer.UserID}, vargs...)
	}
	if f.Kind != "" {
		where += " AND (e.kind = ? OR e.kind LIKE ?)"
		args = append(args, f.Kind, f.Kind+".%")
	}
	if f.Actor != "" {
		where += " AND (e.actor_id = ? OR LOWER(e.actor_name) LIKE ?)"
		args = append(args, f.Actor, "%"+strings.ToLower(f.Actor)+"%")
	}
	if f.Source != "" {
		where += " AND e.source = ?"
		args = append(args, f.Source)
	}
	if f.NoteID != "" {
		where += " AND e.note_id = ?"
		args = append(args, f.NoteID)
	}
	if f.Before != "" {
		where += " AND e.created_at < ?"
		args = append(args, f.Before)
	}
	args = append(args, f.Limit)
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT e.id, e.note_id, COALESCE(e.actor_id, ''), e.actor_name, e.source, e.client, e.kind, e.data, e.created_at,
		COALESCE(a.name, ''), COALESCE(n.title, ''), CASE WHEN e.note_id = '' THEN '' WHEN n.id IS NULL THEN 'deleted'
		WHEN n.deleted_at IS NOT NULL THEN 'trash' ELSE 'live' END
		FROM audit_event e LEFT JOIN note n ON n.id = e.note_id LEFT JOIN note_alias a ON a.note_id = n.id AND a.is_primary = 1
		WHERE `+where+` ORDER BY e.created_at DESC LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var a AuditEntry
		var src, data string
		if err := rows.Scan(&a.ID, &a.NoteID, &a.ActorID, &a.ActorName, &src, &a.Client, &a.Kind, &data, &a.CreatedAt,
			&a.NoteAlias, &a.NoteTitle, &a.NoteState); err != nil {
			return nil, err
		}
		a.Source = Source(src)
		_ = json.Unmarshal([]byte(data), &a.Data)
		if a.NoteTitle == "" {
			if t, ok := a.Data["title"].(string); ok {
				a.NoteTitle = t
			}
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
