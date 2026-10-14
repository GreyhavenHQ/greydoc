package store

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
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

var migrations = []migration{}

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
