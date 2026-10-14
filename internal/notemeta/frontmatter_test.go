package notemeta

import "testing"

func TestExtractFrontmatterIsPresent(t *testing.T) {
	cases := []struct {
		name  string
		lines []string
		want  bool
	}{
		{"is false when note does not contain three dashes at all", []string{"abcdef", "more text"}, false},
		{"is false when note does not start with three dashes", []string{"", "---", "this is not frontmatter"}, false},
		{"is false when note start with less than three dashes", []string{"--", "this is not frontmatter"}, false},
		{"is false when note starts with three dashes but contains other characters in the same line", []string{"--- a", "this is not frontmatter"}, false},
		{"is false when note has no ending marker for frontmatter", []string{"---", "this is not frontmatter", "because", "there is no", "end marker"}, false},
		{"is false when note end marker is present but with not the same amount of dashes as start marker", []string{"---", "this is not frontmatter", "----", "content"}, false},
		{"is true when note end marker is present with the same amount of dashes as start marker", []string{"---", "this is frontmatter", "---", "content"}, true},
		{"is true when note end marker is present with the same amount of dashes as start marker but without content", []string{"---", "this is frontmatter", "---"}, true},
		{"is true when note end marker is present with the same amount of dots as start marker", []string{"---", "this is frontmatter", "...", "content"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ExtractFrontmatter(c.lines) != nil; got != c.want {
				t.Fatalf("present = %v, want %v", got, c.want)
			}
		})
	}
}

func TestExtractFrontmatterLineOffset(t *testing.T) {
	cases := []struct {
		name  string
		lines []string
		want  int
	}{
		{"is correct for single line frontmatter without content", []string{"---", "single line frontmatter", "..."}, 3},
		{"is correct for single line frontmatter with content", []string{"---", "single line frontmatter", "...", "content"}, 3},
		{"is correct for multi-line frontmatter without content", []string{"---", "abc", "123", "def", "..."}, 5},
		{"is correct for multi-line frontmatter with content", []string{"---", "abc", "123", "def", "...", "content"}, 5},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ExtractFrontmatter(c.lines).LineOffset; got != c.want {
				t.Fatalf("lineOffset = %d, want %d", got, c.want)
			}
		})
	}
}

func TestExtractFrontmatterRawText(t *testing.T) {
	if got := ExtractFrontmatter([]string{"---", "single-line", "...", "content"}).RawText; got != "single-line" {
		t.Fatalf("contains single-line frontmatter text: %q", got)
	}
	if got := ExtractFrontmatter([]string{"---", "multi", "line", "...", "content"}).RawText; got != "multi\nline" {
		t.Fatalf("contains multi-line frontmatter text: %q", got)
	}
}

func TestExtractFrontmatterIncomplete(t *testing.T) {
	for _, closer := range []string{"-", "--"} {
		r := ExtractFrontmatter([]string{"---", "type: document", closer, "content"})
		if r == nil || !r.Incomplete {
			t.Fatalf("closed with %q: want incomplete, got %+v", closer, r)
		}
	}
}
