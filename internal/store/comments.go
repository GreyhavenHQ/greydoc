package store

import (
	"context"
	"database/sql"
	"errors"

	"github.com/greyhavenhq/greydoc/internal/secrets"
)

type Comment struct {
	ID         string `json:"id"`
	ThreadID   string `json:"thread_id"`
	AuthorID   string `json:"author_id"`
	AuthorName string `json:"author_name"`
	Source     Source `json:"source"`
	Client     string `json:"client,omitempty"`
	Body       string `json:"body"`
	CreatedAt  string `json:"created_at"`
	EditedAt   string `json:"edited_at,omitempty"`
}

type Thread struct {
	ID          string    `json:"id"`
	NoteID      string    `json:"-"`
	AnchorStart []byte    `json:"anchor_start"`
	AnchorEnd   []byte    `json:"anchor_end"`
	Quote       string    `json:"quote"`
	Status      string    `json:"status"`
	CreatedBy   string    `json:"created_by"`
	CreatedAt   string    `json:"created_at"`
	ResolvedBy  string    `json:"resolved_by,omitempty"`
	ResolvedAt  string    `json:"resolved_at,omitempty"`
	Comments    []Comment `json:"comments"`
}

func (s *Store) CreateThread(ctx context.Context, th *Thread, first *Comment, ev *Event) error {
	if th.ID == "" {
		th.ID = secrets.NewID()
	}
	th.Status, th.CreatedAt = "open", Now()
	first.ID, first.ThreadID, first.CreatedAt = secrets.NewID(), th.ID, th.CreatedAt
	th.Comments = []Comment{*first}
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO comment_thread (id, note_id, anchor_start, anchor_end, quote, status, created_by, created_at)
			VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`), th.ID, th.NoteID, th.AnchorStart, th.AnchorEnd, th.Quote, th.CreatedBy, th.CreatedAt); err != nil {
			return err
		}
		if err := s.insertComment(ctx, tx, first); err != nil {
			return err
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

func (s *Store) insertComment(ctx context.Context, tx execer, c *Comment) error {
	_, err := tx.ExecContext(ctx, s.q(`INSERT INTO comment (id, thread_id, author_id, author_name, source, client, body, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`), c.ID, c.ThreadID, c.AuthorID, c.AuthorName, string(c.Source), c.Client, c.Body, c.CreatedAt)
	return err
}

func (s *Store) AddComment(ctx context.Context, noteID string, c *Comment, ev *Event) error {
	c.ID, c.CreatedAt = secrets.NewID(), Now()
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := s.threadExists(ctx, tx, noteID, c.ThreadID); err != nil {
			return err
		}
		if err := s.insertComment(ctx, tx, c); err != nil {
			return err
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

func (s *Store) threadExists(ctx context.Context, tx execer, noteID, threadID string) error {
	var n int
	if err := tx.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM comment_thread WHERE id = ? AND note_id = ?`), threadID, noteID).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetThreadStatus resolves or reopens a thread.
func (s *Store) SetThreadStatus(ctx context.Context, noteID, threadID, status, by string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := s.threadExists(ctx, tx, noteID, threadID); err != nil {
			return err
		}
		var at any
		if status == "resolved" {
			at = Now()
		} else {
			by = ""
		}
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE comment_thread SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?`),
			status, by, at, threadID); err != nil {
			return err
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

func (s *Store) DeleteThread(ctx context.Context, noteID, threadID string, ev *Event) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, s.q(`DELETE FROM comment_thread WHERE id = ? AND note_id = ?`), threadID, noteID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return s.insertEvent(ctx, tx, ev)
	})
}

func (s *Store) Thread(ctx context.Context, noteID, threadID string) (*Thread, error) {
	ths, err := s.threads(ctx, noteID, threadID)
	if err != nil {
		return nil, err
	}
	if len(ths) == 0 {
		return nil, ErrNotFound
	}
	return &ths[0], nil
}

func (s *Store) Threads(ctx context.Context, noteID string) ([]Thread, error) { return s.threads(ctx, noteID, "") }

func (s *Store) threads(ctx context.Context, noteID, only string) ([]Thread, error) {
	q := `SELECT id, anchor_start, anchor_end, quote, status, created_by, created_at, resolved_by, COALESCE(resolved_at, '')
		FROM comment_thread WHERE note_id = ?`
	args := []any{noteID}
	if only != "" {
		q += ` AND id = ?`
		args = append(args, only)
	}
	rows, err := s.db.QueryContext(ctx, s.q(q+` ORDER BY created_at`), args...)
	if err != nil {
		return nil, err
	}
	var out []Thread
	idx := map[string]int{}
	for rows.Next() {
		th := Thread{NoteID: noteID, Comments: []Comment{}}
		if err := rows.Scan(&th.ID, &th.AnchorStart, &th.AnchorEnd, &th.Quote, &th.Status, &th.CreatedBy, &th.CreatedAt,
			&th.ResolvedBy, &th.ResolvedAt); err != nil {
			rows.Close()
			return nil, err
		}
		idx[th.ID] = len(out)
		out = append(out, th)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return []Thread{}, nil
	}
	rows, err = s.db.QueryContext(ctx, s.q(`SELECT c.id, c.thread_id, c.author_id, c.author_name, c.source, c.client, c.body, c.created_at,
		COALESCE(c.edited_at, '') FROM comment c JOIN comment_thread t ON t.id = c.thread_id WHERE t.note_id = ? ORDER BY c.created_at`), noteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var c Comment
		var src string
		if err := rows.Scan(&c.ID, &c.ThreadID, &c.AuthorID, &c.AuthorName, &src, &c.Client, &c.Body, &c.CreatedAt, &c.EditedAt); err != nil {
			return nil, err
		}
		c.Source = Source(src)
		if i, ok := idx[c.ThreadID]; ok {
			out[i].Comments = append(out[i].Comments, c)
		}
	}
	return out, rows.Err()
}

func (s *Store) CommentAuthor(ctx context.Context, threadID, commentID string) (string, error) {
	var author string
	err := s.db.QueryRowContext(ctx, s.q(`SELECT author_id FROM comment WHERE id = ? AND thread_id = ?`), commentID, threadID).Scan(&author)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return author, err
}

func (s *Store) EditComment(ctx context.Context, threadID, commentID, body string) error {
	_, err := s.db.ExecContext(ctx, s.q(`UPDATE comment SET body = ?, edited_at = ? WHERE id = ? AND thread_id = ?`), body, Now(), commentID, threadID)
	return err
}
