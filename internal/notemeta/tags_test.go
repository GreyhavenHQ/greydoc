package notemeta

import (
	"reflect"
	"testing"
)

func TestParseTagsField(t *testing.T) {
	cases := []struct {
		name  string
		input any
		want  []string
	}{
		{"parses comma-separated strings", "foo, bar,baz", []string{"foo", "bar", "baz"}},
		{"removes empty string entries from comma-separated strings", "foo,, bar", []string{"foo", "bar"}},
		{"parses arrays by stringifying each item", []any{"foo", 123, true}, []string{"foo", "123", "true"}},
		{"removes empty string entries from array entries", []any{"foo", "", "bar"}, []string{"foo", "bar"}},
		{"returns an empty array for invalid input", nil, []string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ParseTagsField(c.input); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %#v, want %#v", got, c.want)
			}
		})
	}
}

func TestLegacyTagLine(t *testing.T) {
	got := Extract("# Title\n###### tags: `design` `q4`\nbody").Tags
	if !reflect.DeepEqual(got, []string{"design", "q4"}) {
		t.Fatalf("%#v", got)
	}
}
