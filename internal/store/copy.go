package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var tableName = regexp.MustCompile(`CREATE TABLE IF NOT EXISTS (\w+)`)

// copyTables are the schema's tables in creation order, so foreign keys are satisfied while copying.
func copyTables() []string {
	var out []string
	for _, m := range tableName.FindAllStringSubmatch(Schema, -1) {
		out = append(out, m[1])
	}
	return out
}

// serialTables have an id sequence on Postgres that must continue after the copied rows.
var serialTables = []string{"note_update", "note_revision"}

// CopyFrom copies every row of src into s, for example a SQLite database into a new Postgres one.
// s MUST be initialized and hold no notes. Rows that exist already, such as the local user, are kept.
func (s *Store) CopyFrom(ctx context.Context, src *Store) error {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM note`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return errors.New("the destination database already has documents; copy into an empty database")
	}
	return s.tx(ctx, func(tx *sql.Tx) error {
		for _, table := range copyTables() {
			if err := s.copyTable(ctx, tx, src, table); err != nil {
				return fmt.Errorf("copy %s: %w", table, err)
			}
		}
		if s.dialect == "postgres" {
			for _, table := range serialTables {
				if _, err := tx.ExecContext(ctx, `SELECT setval(pg_get_serial_sequence('`+table+`', 'id'),
					COALESCE((SELECT MAX(id) FROM `+table+`), 0) + 1, false)`); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func (s *Store) copyTable(ctx context.Context, tx *sql.Tx, src *Store, table string) error {
	rows, err := src.db.QueryContext(ctx, `SELECT * FROM `+table)
	if err != nil {
		return err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return err
	}
	insert := s.q(`INSERT INTO ` + table + ` (` + strings.Join(cols, ", ") + `) VALUES (` +
		strings.TrimSuffix(strings.Repeat("?, ", len(cols)), ", ") + `) ON CONFLICT DO NOTHING`)
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, insert, vals...); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	// The search index lives in a separate SQLite table. Rebuild it when copying into SQLite.
	if table == "note" && s.dialect == "sqlite" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO note_fts (note_id, title, tags, content) SELECT id, title, search_tags, content FROM note`); err != nil {
			return err
		}
	}
	return nil
}
