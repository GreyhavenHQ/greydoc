package store

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/greyhavenhq/greydoc/internal/secrets"
)

// eachDialect runs fn on SQLite, and on Postgres when GREYDOC_TEST_POSTGRES_URL is set.
func eachDialect(t *testing.T, fn func(t *testing.T, st *Store)) {
	t.Run("sqlite", func(t *testing.T) { fn(t, OpenTest(t)) })
	t.Run("postgres", func(t *testing.T) {
		url := os.Getenv("GREYDOC_TEST_POSTGRES_URL")
		if url == "" {
			t.Skip("GREYDOC_TEST_POSTGRES_URL not set")
		}
		fn(t, openPostgresTest(t, url))
	})
}

func openPostgresTest(t *testing.T, url string) *Store {
	t.Helper()
	admin, err := sql.Open("pgx", url)
	if err != nil {
		t.Fatal(err)
	}
	schema := "t_" + secrets.NewID()[:12]
	if _, err := admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec("DROP SCHEMA " + schema + " CASCADE")
		admin.Close()
	})
	sep := "?"
	if strings.Contains(url, "?") {
		sep = "&"
	}
	st, err := Open(url + sep + "search_path=" + schema)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Init(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func TestInitIsIdempotent(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		if err := st.Init(context.Background()); err != nil {
			t.Fatalf("second Init: %v", err)
		}
	})
}

func TestOpenTestUsesTempFile(t *testing.T) {
	st := OpenTest(t)
	if st.Dialect() != "sqlite" {
		t.Fatal(st.Dialect())
	}
	if _, err := os.Stat(filepath.Dir(st.path)); err != nil {
		t.Fatal(err)
	}
}
