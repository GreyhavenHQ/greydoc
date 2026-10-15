package server_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func noRedirect() *http.Client {
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func TestHedgeDoc1Paths(t *testing.T) {
	e := newTestEnv(t)
	code, body := e.do(nil, "POST", "/api/notes", map[string]any{
		"content": "# Weekly\nnotes", "alias": "s3BkeGgqTH-gU5UXqMZdag", "extra_aliases": []string{"SyJdkz5Jx"},
		"created_at": "2021-03-04T10:00:00Z",
	})
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	c := noRedirect()
	get := func(path string) *http.Response {
		t.Helper()
		resp, err := c.Get(e.ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		return resp
	}
	for path, want := range map[string]string{
		"/s3BkeGgqTH-gU5UXqMZdag/publish": "/s/s3BkeGgqTH-gU5UXqMZdag",
		"/SyJdkz5Jx/slide":                "/p/SyJdkz5Jx",
	} {
		if resp := get(path); resp.StatusCode != 302 || resp.Header.Get("Location") != want {
			t.Errorf("%s: %d %s", path, resp.StatusCode, resp.Header.Get("Location"))
		}
	}
	resp := get("/s3BkeGgqTH-gU5UXqMZdag/download")
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(raw) != "# Weekly\nnotes" || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/markdown") {
		t.Fatalf("download: %d %q %s", resp.StatusCode, raw, resp.Header)
	}
	resp = get("/SyJdkz5Jx/info")
	var info map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&info)
	if info["title"] != "Weekly" || info["createtime"] != "2021-03-04T10:00:00.000Z" || info["viewcount"] == nil {
		t.Fatalf("info %v", info)
	}
	if resp := get("/missing-note/download"); resp.StatusCode != 404 {
		t.Fatalf("missing: %d", resp.StatusCode)
	}
	// Other two-part paths are the app's own pages.
	if resp := get("/assets/nothing.js"); resp.StatusCode == 302 {
		t.Fatal("asset path redirected")
	}
}

func TestHedgeDoc1NewAPI(t *testing.T) {
	e := newTestEnv(t)
	c := noRedirect()
	resp, err := c.Post(e.ts.URL+"/new", "text/markdown", strings.NewReader("# From script"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	loc := resp.Header.Get("Location")
	if resp.StatusCode != 302 || !strings.HasPrefix(loc, "/n/") {
		t.Fatalf("%d %s", resp.StatusCode, loc)
	}
	if code, body := e.do(nil, "GET", "/api/notes/"+strings.TrimPrefix(loc, "/n/"), nil); code != 200 || !strings.Contains(body, `"title":"From script"`) {
		t.Fatalf("%d %s", code, body)
	}
	resp, err = c.Post(e.ts.URL+"/new/team-standup", "text/markdown", strings.NewReader("standup"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 302 || resp.Header.Get("Location") != "/n/team-standup" {
		t.Fatalf("free URL: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
}
