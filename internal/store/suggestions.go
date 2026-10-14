package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/greyhavenhq/greydoc/internal/secrets"
)

type Suggestion struct {
	ID          string `json:"id"`
	NoteID      string `json:"-"`
	AnchorStart []byte `json:"anchor_start"`
	AnchorEnd   []byte `json:"anchor_end"`
	Original    string `json:"original"`
	Proposed    string `json:"proposed"`
	Reason      string `json:"reason"`
	Status      string `json:"status"`
	AuthorID    string `json:"author_id"`
	AuthorName  string `json:"author_name"`
	Source      Source `json:"source"`
	Client      string `json:"client,omitempty"`
	CreatedAt   string `json:"created_at"`
	DecidedBy   string `json:"decided_by,omitempty"`
	DecidedAt   string `json:"decided_at,omitempty"`
}

func (s *Store) CreateSuggestion(ctx context.Context, sg *Suggestion, ev *Event) error {
	if sg.ID == "" {
		sg.ID = secrets.NewID()
	}
	sg.Status, sg.CreatedAt = "pending", Now()
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO suggestion (id, note_id, anchor_start, anchor_end, original, proposed, reason,
			status, author_id, author_name, source, client, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`),
			sg.ID, sg.NoteID, sg.AnchorStart, sg.AnchorEnd, sg.Original, sg.Proposed, sg.Reason, sg.AuthorID, sg.AuthorName,
			string(sg.Source), sg.Client, sg.CreatedAt); err != nil {
			return err
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

const suggestionColumns = `id, note_id, anchor_start, anchor_end, original, proposed, reason, status, author_id, author_name, source,
	client, created_at, decided_by, COALESCE(decided_at, '')`

func scanSuggestion(sc interface{ Scan(...any) error }) (*Suggestion, error) {
	var sg Suggestion
	var src string
	if err := sc.Scan(&sg.ID, &sg.NoteID, &sg.AnchorStart, &sg.AnchorEnd, &sg.Original, &sg.Proposed, &sg.Reason, &sg.Status,
		&sg.AuthorID, &sg.AuthorName, &src, &sg.Client, &sg.CreatedAt, &sg.DecidedBy, &sg.DecidedAt); err != nil {
		return nil, err
	}
	sg.Source = Source(src)
	return &sg, nil
}

func (s *Store) Suggestion(ctx context.Context, noteID, id string) (*Suggestion, error) {
	sg, err := scanSuggestion(s.db.QueryRowContext(ctx, s.q(`SELECT `+suggestionColumns+` FROM suggestion WHERE note_id = ? AND id = ?`), noteID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return sg, err
}

// Suggestions lists pending suggestions, plus decided ones when all is set.
func (s *Store) Suggestions(ctx context.Context, noteID string, all bool) ([]Suggestion, error) {
	q := `SELECT ` + suggestionColumns + ` FROM suggestion WHERE note_id = ?`
	if !all {
		q += ` AND status = 'pending'`
	}
	rows, err := s.db.QueryContext(ctx, s.q(q+` ORDER BY created_at`), noteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Suggestion{}
	for rows.Next() {
		sg, err := scanSuggestion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *sg)
	}
	return out, rows.Err()
}

// DecideSuggestion moves a pending suggestion to accepted or rejected. ErrConflict if it was already decided.
func (s *Store) DecideSuggestion(ctx context.Context, noteID, id, status, by string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, s.q(`UPDATE suggestion SET status = ?, decided_by = ?, decided_at = ? WHERE note_id = ? AND id = ? AND status = 'pending'`),
			status, by, Now(), noteID, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrConflict
		}
		return s.insertEvent(ctx, tx, ev)
	})
}
