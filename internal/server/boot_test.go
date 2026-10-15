package server_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// page fetches an HTML page and returns its inlined boot data.
func page(t *testing.T, c *http.Client, url string) (*http.Response, map[string]json.RawMessage) {
	t.Helper()
	if c == nil {
		c = http.DefaultClient
	}
	resp, err := c.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	html := string(b)
	start := strings.Index(html, `<script id="greydoc-boot" type="application/json">`)
	if start < 0 {
		t.Fatalf("no boot data in %s", html)
	}
	html = html[start+len(`<script id="greydoc-boot" type="application/json">`):]
	html = html[:strings.Index(html, "</script>")]
	boot := map[string]json.RawMessage{}
	if err := json.Unmarshal([]byte(html), &boot); err != nil {
		t.Fatalf("boot %q: %v", html, err)
	}
	return resp, boot
}

func TestPagesInlineMeAndNote(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner"})
	alias := e.createNote(owner, "# Report\n\n</script><script>alert(1)</script>")

	resp, boot := page(t, owner, e.ts.URL+"/s/"+alias)
	if resp.Header.Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("cache-control %q", resp.Header.Get("Cache-Control"))
	}
	if !strings.Contains(string(boot["me"]), `"authenticated":true`) || !strings.Contains(string(boot["note"]), `"alias":"`+alias+`"`) ||
		!strings.Contains(string(boot["note"]), `alert(1)`) {
		t.Fatalf("boot %v", boot)
	}
	_, boot = page(t, owner, e.ts.URL+"/p/"+alias)
	if boot["note"] == nil {
		t.Fatal("slides page has no note")
	}
	_, boot = page(t, owner, e.ts.URL+"/")
	if boot["note"] != nil || boot["me"] == nil {
		t.Fatalf("home boot %v", boot)
	}
	_, body := e.do(owner, "GET", "/api/notes/"+alias, nil)
	if !strings.Contains(body, `"view_count":2`) {
		t.Fatalf("each page counts one visit: %s", body)
	}

	_, boot = page(t, nil, e.ts.URL+"/s/"+alias)
	if boot["note"] != nil || !strings.Contains(string(boot["me"]), `"authenticated":false`) {
		t.Fatalf("a guest got the note: %v", boot)
	}
	_, body = e.do(owner, "POST", "/api/notes/"+alias+"/share-links", map[string]string{"label": "client"})
	var link struct {
		Link struct{ Token string } `json:"link"`
	}
	_ = json.Unmarshal([]byte(body), &link)
	_, boot = page(t, nil, e.ts.URL+"/v/"+link.Link.Token)
	if !strings.Contains(string(boot["share"]), `"alias":"`+alias+`"`) || !strings.Contains(string(boot["note"]), `"level":"read"`) {
		t.Fatalf("share boot %v", boot)
	}
	_, boot = page(t, nil, e.ts.URL+"/v/wrong-token")
	if boot["share"] != nil || boot["note"] != nil {
		t.Fatalf("bad token boot %v", boot)
	}
}
