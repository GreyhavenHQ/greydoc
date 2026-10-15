package store

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"

	"github.com/greyhavenhq/greydoc/internal/notemeta"
)

// Migrations carry existing databases forward. Append only. Each one MUST be idempotent against the base schema.

const schemaMigrationDDL = `
CREATE TABLE IF NOT EXISTS schema_migration (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
)`

type migration struct {
	version string
	apply   func(ctx context.Context, tx *sql.Tx, s *Store) error
}

// addColumn adds a column unless the table has it already, so it is a no-op on a fresh database.
func addColumn(version, table, column, definition string) migration {
	return migration{version: version, apply: func(ctx context.Context, tx *sql.Tx, s *Store) error {
		exists, err := s.columnExists(ctx, tx, table, column)
		if err != nil || exists {
			return err
		}
		_, err = tx.ExecContext(ctx, "ALTER TABLE "+table+" ADD COLUMN "+column+" "+definition)
		return err
	}}
}

var migrations = []migration{
	addColumn("001_note_deleted_at", "note", "deleted_at", "TEXT"),
	addColumn("002_note_deleted_by", "note", "deleted_by", "TEXT NOT NULL DEFAULT ''"),
	addColumn("003_note_view_count", "note", "view_count", "BIGINT NOT NULL DEFAULT 0"),
	addColumn("004_suggestion_ai_prompt", "suggestion", "ai_prompt", "TEXT NOT NULL DEFAULT ''"),
	addColumn("005_token_rotated_at", "api_token", "rotated_at", "TEXT NOT NULL DEFAULT ''"),
	{version: "006_note_slides", apply: addSlides},
}

// addSlides adds note.slides and sets it from the front matter of the existing notes.
func addSlides(ctx context.Context, tx *sql.Tx, s *Store) error {
	if err := addColumn("", "note", "slides", "INTEGER NOT NULL DEFAULT 0").apply(ctx, tx, s); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT id, content FROM note WHERE content LIKE '%slide%'`)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id, content string
		if err := rows.Scan(&id, &content); err != nil {
			rows.Close()
			return err
		}
		if notemeta.Extract(content).Slides {
			ids = append(ids, id)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE note SET slides = 1 WHERE id = ?`), id); err != nil {
			return err
		}
	}
	return nil
}

// columnExists checks inside the migration transaction. table comes from a constant, never from input.
func (s *Store) columnExists(ctx context.Context, tx *sql.Tx, table, column string) (bool, error) {
	var n int
	if s.dialect == "postgres" {
		err := tx.QueryRowContext(ctx, `SELECT count(*) FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, table, column).Scan(&n)
		return n > 0, err
	}
	err := tx.QueryRowContext(ctx, `SELECT count(*) FROM pragma_table_info('`+table+`') WHERE name = ?`, column).Scan(&n)
	return n > 0, err
}

func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, schemaMigrationDDL); err != nil {
		return err
	}
	applied := map[string]bool{}
	rows, err := s.db.QueryContext(ctx, `SELECT version FROM schema_migration`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()
	for _, m := range migrations {
		if applied[m.version] {
			continue
		}
		err := s.tx(ctx, func(tx *sql.Tx) error {
			if err := m.apply(ctx, tx, s); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, s.q(`INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)`), m.version, Now())
			return err
		})
		if err != nil {
			return fmt.Errorf("migration %s: %w", m.version, err)
		}
		slog.Info("applied schema migration", "version", m.version)
	}
	return nil
}
