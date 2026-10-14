package notemeta

import (
	"regexp"
	"strings"
)

func GenerateNoteTitle(fm *Frontmatter, firstHeading func() string, previous string) string {
	if fm != nil && strings.TrimSpace(fm.Title) != "" {
		return strings.TrimSpace(fm.Title)
	}
	if fm != nil && strings.TrimSpace(fm.OpenGraphTitle) != "" {
		return strings.TrimSpace(fm.OpenGraphTitle)
	}
	if h := strings.TrimSpace(firstHeading()); h != "" {
		return h
	}
	return strings.TrimSpace(previous)
}

var (
	atxHeading    = regexp.MustCompile(`^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$`)
	setextLine    = regexp.MustCompile(`^ {0,3}(?:=+|-+)[ \t]*$`)
	fenceOpen     = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})")
	inlineLink    = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`)
	inlineMarkers = regexp.MustCompile("[*_`~]+")
)

// FirstHeading returns the plain text of the first ATX or setext heading outside code.
func FirstHeading(body string) string {
	lines := strings.Split(body, "\n")
	fence := ""
	for i, line := range lines {
		if fence != "" {
			if strings.HasPrefix(strings.TrimSpace(line), fence) {
				fence = ""
			}
			continue
		}
		if m := fenceOpen.FindStringSubmatch(line); m != nil {
			fence = m[1]
			continue
		}
		if strings.HasPrefix(line, "    ") || strings.HasPrefix(line, "\t") {
			continue
		}
		if m := atxHeading.FindStringSubmatch(line); m != nil {
			if t := plainInline(m[1]); t != "" {
				return t
			}
			continue
		}
		if strings.TrimSpace(line) != "" && i+1 < len(lines) && setextLine.MatchString(lines[i+1]) &&
			!strings.HasPrefix(strings.TrimSpace(line), "-") {
			return plainInline(line)
		}
	}
	return ""
}

func plainInline(s string) string {
	s = inlineLink.ReplaceAllString(s, "$1")
	s = inlineMarkers.ReplaceAllString(s, "")
	return strings.Join(strings.Fields(s), " ")
}
