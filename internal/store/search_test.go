package store

import (
	"slices"
	"testing"
)

func TestFullTextSearch(t *testing.T) {
	eachDialect(t, func(t *testing.T, st *Store) {
		a, _ := st.CreateNote(ctx, NewNote{Alias: "a"})
		b, _ := st.CreateNote(ctx, NewNote{Alias: "b"})
		c, _ := st.CreateNote(ctx, NewNote{Alias: "c"})
		_ = st.SaveNoteState(ctx, a.ID, NoteState{Title: "Quarterly roadmap", Content: "# Quarterly roadmap\nWe ship the editor."})
		_ = st.SaveNoteState(ctx, b.ID, NoteState{Title: "Lunch", Content: "Pizza on Friday, invoices later", Tags: []string{"finance"}})
		_ = st.SaveNoteState(ctx, c.ID, NoteState{Title: "Other", Content: "nothing relevant"})
		cases := map[string][]string{
			"roadmap":        {a.ID},
			"editor":         {a.ID},
			"finance":        {b.ID},
			"invoice":        {b.ID},
			"quart road":     {a.ID},
			"pizza friday":   {b.ID},
			"zzz":            {},
			`"); DROP TABLE`: {},
		}
		for q, want := range cases {
			got, err := st.SearchNoteIDs(ctx, q, 10)
			if err != nil {
				t.Fatalf("%q: %v", q, err)
			}
			slices.Sort(got)
			slices.Sort(want)
			if !slices.Equal(got, want) {
				t.Errorf("%q: got %v want %v", q, got, want)
			}
		}
		_ = st.SaveNoteState(ctx, a.ID, NoteState{Title: "Renamed", Content: "fresh words"})
		if got, _ := st.SearchNoteIDs(ctx, "roadmap", 10); len(got) != 0 {
			t.Fatalf("stale index: %v", got)
		}
		_ = st.DeleteNote(ctx, b.ID)
		if got, _ := st.SearchNoteIDs(ctx, "pizza", 10); len(got) != 0 {
			t.Fatalf("deleted note found: %v", got)
		}
		snip, err := st.SearchSnippets(ctx, "fresh", []string{a.ID})
		if err != nil || snip[a.ID] == "" {
			t.Fatalf("snippet %v %v", snip, err)
		}
	})
}
