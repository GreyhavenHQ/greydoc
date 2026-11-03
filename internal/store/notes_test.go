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
