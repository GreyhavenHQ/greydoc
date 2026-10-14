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
		"# Hello **bold** and `code`":        "Hello bold and code",
		"## [Link text](http://x) here ##":   "Link text here",
		"#NoSpace\n# Real":                    "Real",
		"    # indented code\n# Real heading": "Real heading",
	}
	for in, want := range cases {
		if got := FirstHeading(in); got != want {
			t.Errorf("FirstHeading(%q) = %q, want %q", in, got, want)
		}
	}
}
