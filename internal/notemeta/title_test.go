package notemeta

import "testing"

func TestGenerateNoteTitle(t *testing.T) {
	heading := func(s string) func() string { return func() string { return s } }
	cases := []struct {
		name     string
		fm       *Frontmatter
		first    func() string
		previous string
		want     string
	}{
		{"will choose the frontmatter title first", &Frontmatter{Title: "frontmatter", OpenGraphTitle: "opengraph"}, heading("first-heading"), "", "frontmatter"},
		{"will choose the opengraph title second", &Frontmatter{OpenGraphTitle: "opengraph"}, heading("first-heading"), "", "opengraph"},
		{"will choose the first heading third", &Frontmatter{}, heading("first-heading"), "", "first-heading"},
		{"falls back to the previous title when the first heading is empty", &Frontmatter{}, heading(""), "previous", "previous"},
		{"returns an empty string if no title source is available", &Frontmatter{}, heading(""), "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := GenerateNoteTitle(c.fm, c.first, c.previous); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestFirstHeadingStripsInlineMarkup(t *testing.T) {
	cases := map[string]string{
		"# Hello **bold** and `code`":         "Hello bold and code",
		"## [Link text](http://x) here ##":    "Link text here",
		"#NoSpace\n# Real":                    "Real",
		"    # indented code\n# Real heading": "Real heading",
	}
	for in, want := range cases {
		if got := FirstHeading(in); got != want {
			t.Errorf("FirstHeading(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPrefixTitle(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"front matter plain", "---\ntitle: Plan\n---\n# Heading", "---\ntitle: Copy of Plan\n---\n# Heading"},
		{"front matter double quoted", "---\ntitle: \"Plan: v2\"\n---\nbody", "---\ntitle: \"Copy of Plan: v2\"\n---\nbody"},
		{"front matter single quoted", "---\ntitle: 'Plan'\n---\nbody", "---\ntitle: 'Copy of Plan'\n---\nbody"},
		{"front matter block scalar", "---\ntitle: |\n  Plan\n---\nbody", "---\ntitle: |\n  Plan\n---\nbody"},
		{"opengraph title", "---\nopengraph:\n  title: Plan\n---\n# Heading", "---\nopengraph:\n  title: Plan\n---\n# Heading"},
		{"front matter without title", "---\ntags: a\n---\n# Heading", "---\ntags: a\n---\n# Copy of Heading"},
		{"atx heading", "intro\n## Plan ##\ntext", "intro\n## Copy of Plan ##\ntext"},
		{"setext heading", "Plan\n====\ntext", "Copy of Plan\n====\ntext"},
		{"heading in code fence", "```\n# not\n```\n# Plan", "```\n# not\n```\n# Copy of Plan"},
		{"empty atx heading", "#\n# Plan", "#\n# Copy of Plan"},
		{"no title", "just text\nmore", "just text\nmore"},
		{"empty", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := PrefixTitle(c.in, "Copy of ")
			if got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
			if before := Extract(c.in).Title; before != "" && got != c.in {
				if after := Extract(got).Title; after != "Copy of "+before {
					t.Fatalf("title %q, want %q", after, "Copy of "+before)
				}
			}
		})
	}
}
