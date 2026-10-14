// Package notemeta derives title, description and tags from note text, as HedgeDoc does.
package notemeta

import (
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

var (
	frontmatterBegin         = regexp.MustCompile(`^-{3,}$`)
	frontmatterEnd           = regexp.MustCompile(`^(?:-{3,}|\.{3,})$`)
	frontmatterIncompleteEnd = regexp.MustCompile(`^-{1,2}$`)
)

type Extraction struct {
	RawText string
	// LineOffset is the number of lines the block takes, fences included.
	LineOffset int
	Incomplete bool
}

// ExtractFrontmatter finds a block that opens with 3+ dashes and closes with the same count of dashes or dots.
func ExtractFrontmatter(lines []string) *Extraction {
	if len(lines) < 2 || !frontmatterBegin.MatchString(lines[0]) {
		return nil
	}
	for i := 1; i < len(lines); i++ {
		if frontmatterIncompleteEnd.MatchString(lines[i]) {
			return &Extraction{LineOffset: i + 1, Incomplete: true}
		}
		if len(lines[i]) == len(lines[0]) && frontmatterEnd.MatchString(lines[i]) {
			return &Extraction{RawText: strings.Join(lines[1:i], "\n"), LineOffset: i + 1}
		}
	}
	return nil
}

type Frontmatter struct {
	Title          string
	Description    string
	Tags           []string
	Type           string
	OpenGraphTitle string
	Raw            map[string]any
}

// ParseFrontmatter decodes YAML. Invalid YAML returns nil, like HedgeDoc's fallback to defaults.
func ParseFrontmatter(raw string) *Frontmatter {
	var m map[string]any
	if err := yaml.Unmarshal([]byte(raw), &m); err != nil || m == nil {
		return nil
	}
	fm := &Frontmatter{Raw: m, Tags: ParseTagsField(m["tags"])}
	fm.Title = stringify(m["title"])
	fm.Description = stringify(m["description"])
	fm.Type = stringify(m["type"])
	if og, ok := m["opengraph"].(map[string]any); ok {
		if t, ok := og["title"].(string); ok {
			fm.OpenGraphTitle = t
		}
	}
	return fm
}

func stringify(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, p := range x {
			parts[i] = stringify(p)
		}
		return strings.Join(parts, ",")
	default:
		return fmt.Sprint(x)
	}
}
