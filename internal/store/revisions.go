package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

type RevisionAuthor struct {
	UserID string `json:"user_id"`
	Name   string `json:"name"`
	Source Source `json:"source"`
}

type Revision struct {
	ID         int64            `json:"id"`
	NoteID     string           `json:"-"`
	Text       string           `json:"text,omitempty"`
	Patch      string           `json:"patch,omitempty"`
	Authors    []RevisionAuthor `json:"authors"`
	Sources    []Source         `json:"sources"`
	Added      int              `json:"added"`
	Removed    int              `json:"removed"`
	FromUpdate int64            `json:"-"`
	ToUpdate   int64            `json:"-"`
	StartedAt  string           `json:"started_at"`
	EndedAt    string           `json:"ended_at"`
}

func (s *Store) HistoryCursor(ctx context.Context, noteID string) (int64, []byte, error) {
	var upto int64
	var state []byte
	err := s.db.QueryRowContext(ctx, s.q(`SELECT history_upto, history_state FROM note WHERE id = ?`), noteID).Scan(&upto, &state)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil, ErrNotFound
	}
	return upto, state, err
}

// CommitHistory stores rev (nil when the text did not change) and advances the history cursor.
func (s *Store) CommitHistory(ctx context.Context, noteID string, rev *Revision, upto int64, state []byte) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if rev != nil {
			authors, _ := json.Marshal(rev.Authors)
			sources := make([]string, len(rev.Sources))
			for i, src := range rev.Sources {
				sources[i] = string(src)
			}
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO note_revision (note_id, text, patch, authors, sources, added, removed,
				from_update, to_update, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
				noteID, rev.Text, rev.Patch, string(authors), strings.Join(sources, ","), rev.Added, rev.Removed,
				rev.FromUpdate, rev.ToUpdate, rev.StartedAt, rev.EndedAt); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx, s.q(`UPDATE note SET history_upto = ?, history_state = ? WHERE id = ?`), upto, state, noteID)
		return err
	})
}

const revisionColumns = `id, note_id, authors, sources, added, removed, from_update, to_update, started_at, ended_at`

func scanRevision(sc interface{ Scan(...any) error }, withText bool) (*Revision, error) {
	var r Revision
	var authors, sources string
	dest := []any{&r.ID, &r.NoteID, &authors, &sources, &r.Added, &r.Removed, &r.FromUpdate, &r.ToUpdate, &r.StartedAt, &r.EndedAt}
	if withText {
		dest = append(dest, &r.Text, &r.Patch)
	}
	if err := sc.Scan(dest...); err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(authors), &r.Authors)
	for _, src := range strings.Split(sources, ",") {
		if src != "" {
			r.Sources = append(r.Sources, Source(src))
		}
	}
	return &r, nil
}

// Revisions lists revisions newest first, without text.
func (s *Store) Revisions(ctx context.Context, noteID string, limit int) ([]Revision, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT `+revisionColumns+` FROM note_revision WHERE note_id = ? ORDER BY id DESC LIMIT ?`), noteID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Revision{}
	for rows.Next() {
		r, err := scanRevision(rows, false)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

func (s *Store) Revision(ctx context.Context, noteID string, id int64) (*Revision, error) {
	r, err := scanRevision(s.db.QueryRowContext(ctx, s.q(`SELECT `+revisionColumns+`, text, patch FROM note_revision
		WHERE note_id = ? AND id = ?`), noteID, id), true)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

func (s *Store) LastRevision(ctx context.Context, noteID string) (*Revision, error) {
	r, err := scanRevision(s.db.QueryRowContext(ctx, s.q(`SELECT `+revisionColumns+`, text, patch FROM note_revision
		WHERE note_id = ? ORDER BY id DESC LIMIT 1`), noteID), true)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// NotesWithPendingHistory lists notes that have updates not yet turned into revisions.
func (s *Store) NotesWithPendingHistory(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT u.note_id FROM note_update u JOIN note n ON n.id = u.note_id
		WHERE u.id > n.history_upto`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// CompactUpdates deletes logged updates that both the snapshot and the history already include.
func (s *Store) CompactUpdates(ctx context.Context, noteID string) error {
	_, err := s.db.ExecContext(ctx, s.q(`DELETE FROM note_update WHERE note_id = ? AND id <=
		(SELECT CASE WHEN ystate_upto < history_upto THEN ystate_upto ELSE history_upto END FROM note WHERE id = ?)`), noteID, noteID)
	return err
}
