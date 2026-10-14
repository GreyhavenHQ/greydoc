package notemeta

import (
	"fmt"
	"regexp"
	"strings"
)

// ParseTagsField accepts a YAML list or the deprecated comma-separated string.
func ParseTagsField(input any) []string {
	out := []string{}
	switch v := input.(type) {
	case string:
		for _, t := range strings.Split(v, ",") {
			if t = strings.TrimSpace(t); t != "" {
				out = append(out, t)
			}
		}
	case []any:
		for _, item := range v {
			if t := strings.TrimSpace(fmt.Sprint(item)); t != "" && item != nil {
				out = append(out, t)
			}
		}
	}
	return out
}

var (
	legacyTagLine = regexp.MustCompile(`(?m)^#{1,6}\s*tags:\s*(.*)$`)
	backtickValue = regexp.MustCompile("`([^`]+)`")
)

// legacyTags reads HedgeDoc 1 syntax: ###### tags: `a` `b`
func legacyTags(body string) []string {
	m := legacyTagLine.FindStringSubmatch(body)
	if m == nil {
		return nil
	}
	var out []string
	for _, v := range backtickValue.FindAllStringSubmatch(m[1], -1) {
		if t := strings.TrimSpace(v[1]); t != "" {
			out = append(out, t)
		}
	}
	return out
}
