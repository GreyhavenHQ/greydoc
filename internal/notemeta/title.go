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
	i, _ := headingLine(lines)
	if i < 0 {
		return ""
	}
	if m := atxHeading.FindStringSubmatch(lines[i]); m != nil {
		return plainInline(m[1])
	}
	return plainInline(lines[i])
}

// headingLine returns the index of the first heading line and the byte offset of its text, or -1.
func headingLine(lines []string) (int, int) {
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
		if m := atxHeading.FindStringSubmatchIndex(line); m != nil {
			if m[2] >= 0 && plainInline(line[m[2]:m[3]]) != "" {
				return i, m[2]
			}
			continue
		}
		if strings.TrimSpace(line) != "" && i+1 < len(lines) && setextLine.MatchString(lines[i+1]) &&
			!strings.HasPrefix(strings.TrimSpace(line), "-") {
			return i, len(line) - len(strings.TrimLeft(line, " "))
		}
	}
	return -1, 0
}

var frontmatterTitle = regexp.MustCompile(`^title:[ \t]*(.*)$`)

// PrefixTitle adds prefix to the line the title comes from. It returns content unchanged when that is not safe.
func PrefixTitle(content, prefix string) string {
	m := Extract(content)
	if m.Title == "" {
		return content
	}
	lines := strings.Split(content, "\n")
	switch {
	case m.Frontmatter != nil && strings.TrimSpace(m.Frontmatter.Title) != "":
		if !prefixFrontmatterTitle(lines[1:m.BodyLine-1], prefix) {
			return content
		}
	case m.Frontmatter != nil && strings.TrimSpace(m.Frontmatter.OpenGraphTitle) != "":
		return content
	default:
		i, start := headingLine(lines[m.BodyLine:])
		if i < 0 {
			return content
		}
		line := lines[m.BodyLine+i]
		lines[m.BodyLine+i] = line[:start] + prefix + line[start:]
	}
	out := strings.Join(lines, "\n")
	if Extract(out).Title != prefix+m.Title {
		return content
	}
	return out
}

func prefixFrontmatterTitle(lines []string, prefix string) bool {
	for i, line := range lines {
		loc := frontmatterTitle.FindStringSubmatchIndex(line)
		if loc == nil {
			continue
		}
		at := loc[2]
		if v := line[at:]; strings.HasPrefix(v, `"`) || strings.HasPrefix(v, "'") {
			at++
		}
		lines[i] = line[:at] + prefix + line[at:]
		return true
	}
	return false
}

func plainInline(s string) string {
	s = inlineLink.ReplaceAllString(s, "$1")
	s = inlineMarkers.ReplaceAllString(s, "")
	return strings.Join(strings.Fields(s), " ")
}
