package store

import (
	"reflect"
	"testing"
)

func TestUserPrefs(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		u, err := st.UpsertOIDCUser(ctx, "sub-1", "alice", "Alice", "", nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(u.Prefs) != 0 {
			t.Fatalf("new user prefs: %v", u.Prefs)
		}
		want := map[string]string{"default_mode": "live", "live_style": "document"}
		if err := st.SetUserPrefs(ctx, u.ID, want); err != nil {
			t.Fatal(err)
		}
		got, err := st.UserByID(ctx, u.ID)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got.Prefs, want) {
			t.Fatalf("prefs: %v", got.Prefs)
		}
		if err := st.SetUserPrefs(ctx, "missing", want); err != ErrNotFound {
			t.Fatalf("missing user: %v", err)
		}
	})
}

func TestMigrationAddsUserPrefsColumn(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		if _, err := st.db.Exec(`ALTER TABLE app_user DROP COLUMN prefs`); err != nil {
			t.Fatal(err)
		}
		if _, err := st.db.Exec(st.q(`DELETE FROM schema_migration WHERE version = ?`), "012_user_prefs"); err != nil {
			t.Fatal(err)
		}
		if err := st.Init(ctx); err != nil {
			t.Fatal(err)
		}
		u, err := st.EnsureLocalUser(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := st.SetUserPrefs(ctx, u.ID, map[string]string{"live_style": "obsidian"}); err != nil {
			t.Fatal(err)
		}
	})
}
