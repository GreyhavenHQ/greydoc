package notemeta

import (
	"regexp"
	"strings"
)

var (
	mentionLink = regexp.MustCompile(`\\?\[@([^\]\n]*)\]\(@([A-Za-z0-9][A-Za-z0-9._@+-]*)\)`)
	codeSpan    = regexp.MustCompile("`+")
)

// Mentions returns the usernames written as [@Name](@username), outside code and front matter.
func Mentions(text string) []string {
	lines := strings.Split(text, "\n")
	if fm := ExtractFrontmatter(lines); fm != nil {
		lines = lines[fm.LineOffset:]
	}
	out := []string{}
	seen := map[string]bool{}
	fence := ""
	for _, line := range lines {
		if fence != "" {
			if m := fenceOpen.FindStringSubmatch(line); m != nil && m[1][0] == fence[0] && len(m[1]) >= len(fence) && strings.TrimSpace(line[len(m[0]):]) == "" {
				fence = ""
			}
			continue
		}
		if m := fenceOpen.FindStringSubmatch(line); m != nil {
			fence = m[1]
			continue
		}
		for _, m := range mentionLink.FindAllStringSubmatch(stripCodeSpans(line), -1) {
			if m[0][0] == '\\' {
				continue
			}
			u := strings.ToLower(m[2])
			if !seen[u] {
				seen[u] = true
				out = append(out, u)
			}
		}
	}
	return out
}

// stripCodeSpans blanks text between backtick runs of equal length.
func stripCodeSpans(line string) string {
	runs := codeSpan.FindAllStringIndex(line, -1)
	var b strings.Builder
	last := 0
	for i := 0; i < len(runs); i++ {
		open := runs[i]
		for j := i + 1; j < len(runs); j++ {
			if runs[j][1]-runs[j][0] == open[1]-open[0] {
				b.WriteString(line[last:open[0]])
				b.WriteString(" ")
				last = runs[j][1]
				i = j
				break
			}
		}
	}
	b.WriteString(line[last:])
	return b.String()
}

// MentionsToText writes each mention as @Name, for plain-text excerpts.
func MentionsToText(text string) string {
	return mentionLink.ReplaceAllStringFunc(text, func(m string) string {
		if m[0] == '\\' {
			return m
		}
		return "@" + mentionLink.FindStringSubmatch(m)[1]
	})
}
