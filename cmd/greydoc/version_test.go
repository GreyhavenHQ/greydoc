package main

import "testing"

func TestVersionString(t *testing.T) {
	cases := []struct{ v, c, b, want string }{
		{"dev", "", "", "dev"},
		{"v1.0.0", "abc1234", "", "v1.0.0 (abc1234)"},
		{"v1.0.0", "", "2026-10-14", "v1.0.0 (built 2026-10-14)"},
		{"v1.0.0", "abc1234", "2026-10-14", "v1.0.0 (abc1234, built 2026-10-14)"},
	}
	for _, c := range cases {
		if got := versionString(c.v, c.c, c.b); got != c.want {
			t.Errorf("versionString(%q,%q,%q) = %q, want %q", c.v, c.c, c.b, got, c.want)
		}
	}
}
