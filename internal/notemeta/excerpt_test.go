package notemeta

import "testing"

func TestExcerpt(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"paragraph after heading", "# Title\n\nFirst **real** line.\nSecond.", "First real line."},
		{"front matter", "---\ntitle: X\ntags: [a]\n---\n# X\nBody text", "Body text"},
		{"incomplete front matter", "---\ntitle: X\n", ""},
		{"code and images skipped", "```go\nfunc x() {}\n```\n![img](a.png)\nAfter code", "After code"},
		{"list marker and link", "# T\n- [x] see [the plan](/n/plan) now", "see the plan now"},
		{"setext heading", "Heading\n=======\n\nText", "Text"},
		{"only a heading", "# Just a title", ""},
		{"cut", "# T\n" + "abcdefghij", "abcde…"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			max := 160
			if c.name == "cut" {
				max = 5
			}
			if got := Excerpt(c.in, max); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}
