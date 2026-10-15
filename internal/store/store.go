// Package store is the source of truth: SQLite (pure Go) by default, Postgres with a postgres:// URL.
package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

var (
	ErrNotFound             = errors.New("not found")
	ErrAliasTaken           = errors.New("alias already in use")
	ErrAliasForbidden       = errors.New("alias is forbidden")
	ErrPrimaryAliasDeletion = errors.New("the primary alias cannot be removed")
	ErrConflict             = errors.New("conflict")
)

type Store struct {
	db      *sql.DB
	dialect string
	path    string
	lock    *sql.Conn
}

func Open(databaseURL string) (*Store, error) {
	if strings.HasPrefix(databaseURL, "postgres://") || strings.HasPrefix(databaseURL, "postgresql://") {
		db, err := sql.Open("pgx", databaseURL)
		if err != nil {
			return nil, err
		}
		db.SetMaxOpenConns(20)
		return &Store{db: db, dialect: "postgres"}, nil
	}
	path := strings.TrimPrefix(databaseURL, "sqlite://")
	dsn := "file:" + path +
		"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(30000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	return &Store{db: db, dialect: "sqlite", path: path}, nil
}

// OpenTest returns an initialized store on a temp SQLite file, closed at test end.
func OpenTest(t testing.TB) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Init(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func (s *Store) Close() error {
	if s.lock != nil {
		_ = s.lock.Close()
	}
	return s.db.Close()
}

// instanceLockKey is the Postgres advisory lock that marks the one running greydoc server.
const instanceLockKey = 0x67726579646f63

// LockInstance makes sure that only one server uses a Postgres database. Rooms live in memory,
// so a second server would not see live edits. SQLite needs no lock: it is one file on one host.
func (s *Store) LockInstance(ctx context.Context) error {
	if s.dialect != "postgres" {
		return nil
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	var ok bool
	if err := conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1)`, instanceLockKey).Scan(&ok); err != nil {
		conn.Close()
		return err
	}
	if !ok {
		conn.Close()
		return errors.New("another greydoc server is using this database; run one instance only")
	}
	s.lock = conn
	return nil
}

func (s *Store) Dialect() string { return s.dialect }

func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

func (s *Store) Init(ctx context.Context) error {
	for _, stmt := range strings.Split(schemaFor(s.dialect), ";") {
		stmt = strings.ReplaceAll(strings.TrimSpace(stmt), triggerSemicolon, ";")
		if stmt == "" {
			continue
		}
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return errors.New(err.Error() + " in: " + firstLine(stmt))
		}
	}
	return s.migrate(ctx)
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// q rewrites ? placeholders to $n for Postgres.
func (s *Store) q(query string) string {
	if s.dialect != "postgres" {
		return query
	}
	var b strings.Builder
	n := 0
	for _, ch := range query {
		if ch == '?' {
			n++
			b.WriteString("$" + strconv.Itoa(n))
		} else {
			b.WriteRune(ch)
		}
	}
	return b.String()
}

type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func (s *Store) tx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// TimeFormat is UTC, fixed width and sortable as text, identical on both backends.
const TimeFormat = "2006-01-02T15:04:05.000000Z"

func Now() string { return time.Now().UTC().Format(TimeFormat) }

func FormatTime(t time.Time) string { return t.UTC().Format(TimeFormat) }

func ParseTime(s string) time.Time {
	t, _ := time.Parse(TimeFormat, s)
	return t
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "UNIQUE constraint") || strings.Contains(msg, "duplicate key") || strings.Contains(msg, "23505")
}
