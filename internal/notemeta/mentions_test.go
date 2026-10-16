package notemeta

import (
	"reflect"
	"testing"
)

func TestMentions(t *testing.T) {
	cases := []struct {
		name string
		text string
		want []string
	}{
		{"finds a mention", "Hi [@Alice Martin](@alice), see this.", []string{"alice"}},
		{"keeps order and drops duplicates", "[@B](@bob) [@A](@alice) [@Bob](@bob)", []string{"bob", "alice"}},
		{"lowercases the username", "[@Alice](@Alice)", []string{"alice"}},
		{"accepts email-like usernames", "[@A](@alice@example.com)", []string{"alice@example.com"}},
		{"ignores a plain at sign", "mail @alice or [link](https://x)", []string{}},
		{"ignores a link to a page", "[@alice](https://example.com)", []string{}},
		{"ignores bad usernames", "[@x](@) [@y](@a b) [@z](@-x)", []string{}},
		{"ignores code spans", "use `[@A](@alice)` and ``[@B](@bob)``", []string{}},
		{"ignores fenced code", "```\n[@A](@alice)\n```\n~~~md\n[@B](@bob)\n~~~\n[@C](@carol)", []string{"carol"}},
		{"ignores an unclosed fence to the end", "```\n[@A](@alice)", []string{}},
		{"ignores front matter", "---\nnote: \"[@A](@alice)\"\n---\n[@B](@bob)", []string{"bob"}},
		{"ignores escaped brackets", `\[@A](@alice)`, []string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Mentions(c.text); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %#v, want %#v", got, c.want)
			}
		})
	}
}
