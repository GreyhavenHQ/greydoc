package notemeta

import (
	"reflect"
	"testing"
)

func TestExtract(t *testing.T) {
	cases := []struct {
		name, content, title, description string
		tags                              []string
	}{
		{"works without frontmatter without first heading", "This is a note content", "", "", []string{}},
		{"works with broken frontmatter", "---\ntitle: \n  - 1\n  - 2\n---\nThis is a note content", "1,2", "", []string{}},
		{"works with frontmatter title", "---\ntitle: note title\n---\nThis is a note content", "note title", "", []string{}},
		{"works with first heading title", "# Note Title Heading\nThis is a note content", "Note Title Heading", "", []string{}},
		{"works with frontmatter description", "---\ndescription: note description\n---\nNote content", "", "note description", []string{}},
		{"extracts tags as list", "---\ntags: \n  - tag1\n  - tag2\n---\nNote content", "", "", []string{"tag1", "tag2"}},
		{"extracts tags in legacy syntax", "---\ntags: \"tag1, tag2\"\n---\nNote content", "", "", []string{"tag1", "tag2"}},
		{"first heading after frontmatter", "---\ntags: [a]\n---\n\n## Second *level*\n# Later", "Second level", "", []string{"a"}},
		{"ignores headings in code fences", "```\n# not a title\n```\nSetext title\n===\n", "Setext title", "", []string{}},
		{"invalid yaml falls back to defaults", "---\ntitle: [unclosed\n---\n# Heading", "Heading", "", []string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := Extract(c.content)
			if m.Title != c.title || m.Description != c.description || !reflect.DeepEqual(m.Tags, c.tags) {
				t.Fatalf("got title=%q description=%q tags=%#v", m.Title, m.Description, m.Tags)
			}
		})
	}
}

func TestExtractSlides(t *testing.T) {
	for content, want := range map[string]bool{
		"---\ntype: slide\n---\n# Deck":  true,
		"---\ntype: Slides\n---\n# Deck": true,
		"---\ntype: note\n---\n# Doc":    false,
		"# type: slide":                  false,
	} {
		if got := Extract(content).Slides; got != want {
			t.Errorf("%q: slides %v", content, got)
		}
	}
}
