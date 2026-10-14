package store

import (
	"context"
	"encoding/json"

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
