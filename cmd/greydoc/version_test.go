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

func TestTokenCommandMintsAPAT(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GREYDOC_DATABASE_URL", dir+"/db")
	t.Setenv("GREYDOC_SECRET_FILE", dir+"/secret")
	t.Setenv("GREYDOC_OIDC_ISSUER", "")
	out := captureStdout(t, func() {
		if err := cmdToken([]string{"create", "--label", "ci"}); err != nil {
			t.Fatal(err)
		}
	})
	if len(out) < 20 || out[:7] != "gd_pat_" {
		t.Fatalf("token %q", out)
	}
}
