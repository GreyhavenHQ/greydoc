package store

import (
	"context"
	"database/sql"
	"strings"
	"unicode"
)

// terms splits a query into words, keeping letters and digits only.
func terms(q string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(strings.ToLower(q), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) }) {
		if len(out) < 10 {
			out = append(out, w)
		}
	}
	return out
}

func (s *Store) indexNote(ctx context.Context, tx *sql.Tx, id string, st NoteState) error {
	if s.dialect == "postgres" {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM note_fts WHERE note_id = ?`, id); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO note_fts (note_id, title, tags, content) VALUES (?, ?, ?, ?)`,
		id, st.Title, strings.Join(st.Tags, " "), st.Content)
	return err
}

// SearchNoteIDs returns notes matching every word, by prefix, best first.
func (s *Store) SearchNoteIDs(ctx context.Context, q string, limit int) ([]string, error) {
	words := terms(q)
	if len(words) == 0 {
		return []string{}, nil
	}
	var rows *sql.Rows
	var err error
	if s.dialect == "postgres" {
		tsq := strings.Join(words, ":* & ") + ":*"
		rows, err = s.db.QueryContext(ctx, `SELECT id FROM note
			WHERE to_tsvector('simple', title || ' ' || search_tags || ' ' || content) @@ to_tsquery('simple', $1)
			ORDER BY ts_rank(to_tsvector('simple', title || ' ' || search_tags || ' ' || content), to_tsquery('simple', $1)) DESC, updated_at DESC
			LIMIT $2`, tsq, limit)
	} else {
		parts := make([]string, len(words))
		for i, w := range words {
			parts[i] = `"` + w + `"*`
		}
		rows, err = s.db.QueryContext(ctx, `SELECT note_id FROM note_fts WHERE note_fts MATCH ? ORDER BY bm25(note_fts, 0, 10, 5, 1) LIMIT ?`,
			strings.Join(parts, " AND "), limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// SearchSnippets returns a short excerpt around the first match, per note.
func (s *Store) SearchSnippets(ctx context.Context, q string, ids []string) (map[string]string, error) {
	out := map[string]string{}
	words := terms(q)
	if len(words) == 0 {
		return out, nil
	}
	for _, id := range ids {
		var content string
		if err := s.db.QueryRowContext(ctx, s.q(`SELECT content FROM note WHERE id = ?`), id).Scan(&content); err != nil {
			continue
		}
		out[id] = snippet(content, words)
	}
	return out, nil
}

func snippet(content string, words []string) string {
	lower := strings.ToLower(content)
	at := -1
	for _, w := range words {
		if i := strings.Index(lower, w); i >= 0 && (at < 0 || i < at) {
			at = i
		}
	}
	if at < 0 {
		at = 0
	}
	r := []rune(content)
	runeAt := len([]rune(content[:at]))
	start := max(0, runeAt-60)
	end := min(len(r), runeAt+100)
	out := strings.Join(strings.Fields(string(r[start:end])), " ")
	if start > 0 {
		out = "…" + out
	}
	if end < len(r) {
		out += "…"
	}
	return out
}
