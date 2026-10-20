package notemeta

import (
	"regexp"
	"strings"
)

var listMarker = regexp.MustCompile(`^(?:(?:[-*+]|\d+[.)]|>)\s*)+(?:\[[ xX]\]\s*)?`)

// Excerpt returns the first line of plain text after the front matter, headings and code, cut to max runes.
func Excerpt(content string, max int) string {
	lines := strings.Split(content, "\n")
	start := 0
	if ex := ExtractFrontmatter(lines); ex != nil && !ex.Incomplete {
		start = ex.LineOffset
	} else if frontmatterBegin.MatchString(lines[0]) {
		// Front matter that does not close here, for example cut by the caller.
		return ""
	}
	fence := ""
	for i := start; i < len(lines); i++ {
		line := lines[i]
		t := strings.TrimSpace(line)
		if fence != "" {
			if strings.HasPrefix(t, fence) {
				fence = ""
			}
			continue
		}
		if m := fenceOpen.FindStringSubmatch(line); m != nil {
			fence = m[1]
			continue
		}
		if t == "" || atxHeading.MatchString(line) || setextLine.MatchString(line) || strings.HasPrefix(t, "|") ||
			strings.HasPrefix(t, "<") || strings.HasPrefix(t, "$$") || strings.HasPrefix(t, "![") {
			continue
		}
		if i+1 < len(lines) && setextLine.MatchString(lines[i+1]) && !strings.HasPrefix(t, "-") {
			continue
		}
		t = plainInline(listMarker.ReplaceAllString(t, ""))
		if t == "" {
			continue
		}
		if r := []rune(t); len(r) > max {
			t = strings.TrimSpace(string(r[:max])) + "…"
		}
		return t
	}
	return ""
}
