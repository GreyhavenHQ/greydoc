package notemeta

import "strings"

type Meta struct {
	Title       string
	Description string
	Tags        []string
	Frontmatter *Frontmatter
	// BodyLine is the zero-based index of the first line after the front matter.
	BodyLine int
}

func Extract(content string) Meta {
	lines := strings.Split(content, "\n")
	m := Meta{Tags: []string{}}
	if ex := ExtractFrontmatter(lines); ex != nil && !ex.Incomplete {
		m.BodyLine = ex.LineOffset
		m.Frontmatter = ParseFrontmatter(ex.RawText)
	}
	body := strings.Join(lines[m.BodyLine:], "\n")
	m.Title = GenerateNoteTitle(m.Frontmatter, func() string { return FirstHeading(body) }, "")
	if m.Frontmatter != nil {
		m.Description = strings.TrimSpace(m.Frontmatter.Description)
		m.Tags = m.Frontmatter.Tags
	}
	if len(m.Tags) == 0 {
		if legacy := legacyTags(body); len(legacy) > 0 {
			m.Tags = legacy
		}
	}
	return m
}
