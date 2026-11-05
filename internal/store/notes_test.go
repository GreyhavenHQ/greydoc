package store

import (
	"context"
	"errors"
	"regexp"
	"testing"
)

var ctx = context.Background()

func TestGenerateRandomAlias(t *testing.T) {
	a := GenerateRandomAlias()
	if len(a) != 26 || !regexp.MustCompile(`^[0-9a-z]{26}$`).MatchString(a) {
		t.Fatalf("alias %q: want 26 lowercase base32 chars", a)
	}
	if a == GenerateRandomAlias() {
		t.Fatal("aliases repeat")
	}
}

func TestCreateNoteGetsPrimaryAlias(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, err := st.CreateNote(ctx, NewNote{Content: "# Hello"})
		if err != nil {
			t.Fatal(err)
		}
		if n.PrimaryAlias == "" || n.Content != "# Hello" {
			t.Fatalf("note %+v", n)
		}
		got, err := st.NoteByAlias(ctx, n.PrimaryAlias)
		if err != nil || got.ID != n.ID {
			t.Fatalf("by alias: %v %+v", err, got)
		}
		if got.AgentPolicy != AgentSuggest {
			t.Fatalf("default agent policy %q", got.AgentPolicy)
		}
	})
}

func TestAddAlias(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{Alias: "first"})
		t.Run("a non-primary alias if a primary alias is already present", func(t *testing.T) {
			if err := st.AddAlias(ctx, n.ID, "second"); err != nil {
				t.Fatal(err)
			}
			aliases, _ := st.Aliases(ctx, n.ID)
			if len(aliases) != 2 || !aliases[0].Primary || aliases[0].Name != "first" || aliases[1].Primary {
				t.Fatalf("%+v", aliases)
			}
		})
		t.Run("already used alias", func(t *testing.T) {
			other, _ := st.CreateNote(ctx, NewNote{})
			if err := st.AddAlias(ctx, other.ID, "SECOND"); !errors.Is(err, ErrAliasTaken) {
				t.Fatalf("want ErrAliasTaken, got %v", err)
			}
		})
		t.Run("forbidden alias", func(t *testing.T) {
			for _, a := range []string{"new", "api", "s", "p", "n", "mcp", "trash", "audit", "features", "bad alias", ""} {
				if err := st.AddAlias(ctx, n.ID, a); !errors.Is(err, ErrAliasForbidden) {
					t.Fatalf("%q: want ErrAliasForbidden, got %v", a, err)
				}
			}
		})
		t.Run("lookup is case insensitive", func(t *testing.T) {
			got, err := st.NoteByAlias(ctx, "First")
			if err != nil || got.ID != n.ID {
				t.Fatalf("%v %+v", err, got)
			}
		})
	})
}

func TestMakeAliasPrimary(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{Alias: "one"})
		_ = st.AddAlias(ctx, n.ID, "two")
		t.Run("marks the alias as primary", func(t *testing.T) {
			if err := st.MakeAliasPrimary(ctx, n.ID, "two"); err != nil {
				t.Fatal(err)
			}
			got, _ := st.NoteByID(ctx, n.ID)
			if got.PrimaryAlias != "two" {
				t.Fatalf("primary %q", got.PrimaryAlias)
			}
		})
		t.Run("does not mark the aliases as primary, if the alias does not exist", func(t *testing.T) {
			if err := st.MakeAliasPrimary(ctx, n.ID, "nope"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("want ErrNotFound, got %v", err)
			}
			got, _ := st.NoteByID(ctx, n.ID)
			if got.PrimaryAlias != "two" {
				t.Fatalf("primary changed to %q", got.PrimaryAlias)
			}
		})
	})
}

func TestRemoveAlias(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{Alias: "keep"})
		_ = st.AddAlias(ctx, n.ID, "drop")
		t.Run("fails if alias does not exist", func(t *testing.T) {
			if err := st.RemoveAlias(ctx, "missing"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("want ErrNotFound, got %v", err)
			}
		})
		t.Run("fails if alias is primary", func(t *testing.T) {
			if err := st.RemoveAlias(ctx, "keep"); !errors.Is(err, ErrPrimaryAliasDeletion) {
				t.Fatalf("want ErrPrimaryAliasDeletion, got %v", err)
			}
		})
		t.Run("correctly deletes the alias", func(t *testing.T) {
			if err := st.RemoveAlias(ctx, "drop"); err != nil {
				t.Fatal(err)
			}
			if _, err := st.NoteByAlias(ctx, "drop"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("alias still resolves: %v", err)
			}
		})
	})
}

func TestDeleteNote(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		if err := st.DeleteNote(ctx, "missing"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("want ErrNotFound, got %v", err)
		}
		n, _ := st.CreateNote(ctx, NewNote{Alias: "gone"})
		if err := st.DeleteNote(ctx, n.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := st.NoteByAlias(ctx, "gone"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("note still resolves: %v", err)
		}
	})
}

func TestSaveNoteState(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{})
		err := st.SaveNoteState(ctx, n.ID, NoteState{
			YState: []byte{1, 2, 3}, Content: "---\ntags: [a]\n---\n# T", Title: "T", Tags: []string{"a", "b"},
		})
		if err != nil {
			t.Fatal(err)
		}
		got, _ := st.NoteByID(ctx, n.ID)
		if string(got.YState) != "\x01\x02\x03" || got.Title != "T" || len(got.Tags) != 2 || got.Tags[0] != "a" {
			t.Fatalf("%+v", got)
		}
	})
}

func TestImportedTimesSurviveUnchangedSaves(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, err := st.CreateNote(ctx, NewNote{Alias: "old", CreatedAt: "2021-03-04T10:00:00.000000Z", UpdatedAt: "2022-01-02T00:00:00.000000Z"})
		if err != nil {
			t.Fatal(err)
		}
		_ = st.SaveNoteState(ctx, n.ID, NoteState{Content: ""})
		got, _ := st.NoteByID(ctx, n.ID)
		if got.CreatedAt != "2021-03-04T10:00:00.000000Z" || got.UpdatedAt != "2022-01-02T00:00:00.000000Z" {
			t.Fatalf("times changed without an edit: %+v", got)
		}
		_ = st.SaveNoteState(ctx, n.ID, NoteState{Content: "edited"})
		got, _ = st.NoteByID(ctx, n.ID)
		if got.UpdatedAt <= "2022-01-02T00:00:00.000000Z" {
			t.Fatalf("an edit kept the old time: %s", got.UpdatedAt)
		}
	})
}

func TestHedgeDocStyleAliases(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, err := st.CreateNote(ctx, NewNote{Alias: "-q8sZjE2S5mXJTTVyr4nqQ"})
		if err != nil {
			t.Fatal(err)
		}
		for _, a := range []string{"-q8sZjE2S5mXJTTVyr4nqQ", "-q8szje2s5mxjttvyr4nqq"} {
			if got, err := st.NoteByAlias(ctx, a); err != nil || got.ID != n.ID {
				t.Fatalf("%s: %v", a, err)
			}
		}
		if _, err := st.CreateNote(ctx, NewNote{Alias: "--"}); err != ErrAliasForbidden {
			t.Fatalf("dash-only alias: %v", err)
		}
	})
}

func TestNoteByAliasAcceptsID(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{Alias: "by-id"})
		got, err := st.NoteByAlias(ctx, n.ID)
		if err != nil || got.ID != n.ID || got.PrimaryAlias != "by-id" {
			t.Fatalf("%v %+v", err, got)
		}
		if _, err := st.NoteByAlias(ctx, "0123456789abcdef0123456789abcdef"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown id: %v", err)
		}
	})
}

func TestNormalizeAliasRefusesIDShape(t *testing.T) {
	if _, err := NormalizeAlias("0123456789abcdef0123456789ABCDEF"); !errors.Is(err, ErrAliasForbidden) {
		t.Fatalf("id shape: %v", err)
	}
	for _, a := range []string{GenerateRandomAlias(), "-q8sZjE2S5mXJTTVyr4nqQ", "0123456789abcdef0123456789abcdeg"} {
		if _, err := NormalizeAlias(a); err != nil {
			t.Fatalf("%q: %v", a, err)
		}
	}
}

func aliasNames(t *testing.T, st *Store, noteID string) []string {
	t.Helper()
	as, err := st.Aliases(ctx, noteID)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, a := range as {
		out = append(out, a.Name)
	}
	return out
}

func slugEvents(t *testing.T, st *Store, noteID string) []Event {
	t.Helper()
	evs, err := st.Events(ctx, noteID, 50)
	if err != nil {
		t.Fatal(err)
	}
	var out []Event
	for _, ev := range evs {
		if ev.Kind == "alias.change" {
			out = append(out, ev)
		}
	}
	return out
}

func TestSetSlug(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{ExtraAliases: []string{"imported"}})
		random := n.PrimaryAlias
		ev := func() *Event { return &Event{ActorName: "ann", Kind: "alias.change"} }

		t.Run("the first slug becomes primary and keeps the other aliases", func(t *testing.T) {
			got, err := st.SetSlug(ctx, n.ID, "Team-Roadmap", ev())
			if err != nil || got != "team-roadmap" {
				t.Fatalf("%q %v", got, err)
			}
			if names := aliasNames(t, st, n.ID); len(names) != 3 || names[0] != "team-roadmap" {
				t.Fatalf("aliases %v", names)
			}
			evs := slugEvents(t, st, n.ID)
			if len(evs) != 1 || evs[0].Data["alias"] != "team-roadmap" || evs[0].Data["previous"] != random {
				t.Fatalf("events %+v", evs)
			}
		})
		t.Run("a second slug releases the first", func(t *testing.T) {
			if _, err := st.SetSlug(ctx, n.ID, "roadmap-2027", ev()); err != nil {
				t.Fatal(err)
			}
			if _, err := st.NoteByAlias(ctx, "team-roadmap"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("old slug: %v", err)
			}
			for _, a := range []string{random, "imported", "roadmap-2027", n.ID} {
				if got, err := st.NoteByAlias(ctx, a); err != nil || got.ID != n.ID || got.PrimaryAlias != "roadmap-2027" {
					t.Fatalf("%s: %v %+v", a, err, got)
				}
			}
			evs := slugEvents(t, st, n.ID)
			if len(evs) != 2 || evs[0].Data["previous"] != "team-roadmap" {
				t.Fatalf("events %+v", evs)
			}
		})
		t.Run("a released slug is free for another note", func(t *testing.T) {
			other, _ := st.CreateNote(ctx, NewNote{})
			if _, err := st.SetSlug(ctx, other.ID, "team-roadmap", nil); err != nil {
				t.Fatal(err)
			}
		})
		t.Run("the slug of another note is taken", func(t *testing.T) {
			if _, err := st.SetSlug(ctx, n.ID, "team-roadmap", ev()); !errors.Is(err, ErrAliasTaken) {
				t.Fatalf("want ErrAliasTaken, got %v", err)
			}
			if got, _ := st.NoteByID(ctx, n.ID); got.PrimaryAlias != "roadmap-2027" {
				t.Fatalf("primary %q", got.PrimaryAlias)
			}
		})
		t.Run("forbidden slugs", func(t *testing.T) {
			for _, a := range []string{"api", "bad slug", n.ID} {
				if _, err := st.SetSlug(ctx, n.ID, a, ev()); !errors.Is(err, ErrAliasForbidden) {
					t.Fatalf("%q: %v", a, err)
				}
			}
		})
		t.Run("the current slug is a no-op", func(t *testing.T) {
			if _, err := st.SetSlug(ctx, n.ID, "roadmap-2027", ev()); err != nil {
				t.Fatal(err)
			}
			if evs := slugEvents(t, st, n.ID); len(evs) != 2 {
				t.Fatalf("events %+v", evs)
			}
		})
		t.Run("an own secondary alias is promoted and kept on the next change", func(t *testing.T) {
			if _, err := st.SetSlug(ctx, n.ID, "imported", ev()); err != nil {
				t.Fatal(err)
			}
			if _, err := st.NoteByAlias(ctx, "roadmap-2027"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("old slug: %v", err)
			}
			if _, err := st.SetSlug(ctx, n.ID, "final", ev()); err != nil {
				t.Fatal(err)
			}
			if got, err := st.NoteByAlias(ctx, "imported"); err != nil || got.ID != n.ID {
				t.Fatalf("imported alias: %v", err)
			}
		})
	})
}

func TestMakeAliasPrimaryReleasesCustomSlug(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{})
		if _, err := st.SetSlug(ctx, n.ID, "custom", nil); err != nil {
			t.Fatal(err)
		}
		if err := st.MakeAliasPrimary(ctx, n.ID, n.PrimaryAlias); err != nil {
			t.Fatal(err)
		}
		if _, err := st.NoteByAlias(ctx, "custom"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("custom slug: %v", err)
		}
	})
}

func TestMigrationAddsCustomAliasColumn(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		n, _ := st.CreateNote(ctx, NewNote{})
		if _, err := st.db.Exec(`ALTER TABLE note_alias DROP COLUMN custom`); err != nil {
			t.Fatal(err)
		}
		if _, err := st.db.Exec(st.q(`DELETE FROM schema_migration WHERE version = ?`), "011_note_alias_custom"); err != nil {
			t.Fatal(err)
		}
		if err := st.Init(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := st.SetSlug(ctx, n.ID, "after-migration", nil); err != nil {
			t.Fatal(err)
		}
	})
}
