package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/greyhavenhq/greydoc/internal/config"
)

var pngBytes = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82")

func upload(t *testing.T, e *testEnv, c *http.Client, alias, name string, data []byte) (int, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	_ = mw.Close()
	req, _ := http.NewRequest("POST", e.ts.URL+"/api/notes/"+alias+"/media", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	if c == nil {
		c = http.DefaultClient
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestMediaUpload(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner"})
	viewer := e.login(idp, map[string]any{"sub": "v", "preferred_username": "viewer"})
	alias := e.createNote(owner, "pics")
	e.do(owner, "DELETE", "/api/notes/"+alias+"/permissions/groups/_signed_in", nil)
	e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/users/viewer", map[string]string{"level": "read"})

	if code, _ := upload(t, e, viewer, alias, "a.png", pngBytes); code != 403 {
		t.Fatalf("reader uploaded: %d", code)
	}
	if code, _ := upload(t, e, owner, alias, "page.html", []byte("<script>alert(1)</script>")); code != 415 {
		t.Fatalf("html accepted: %d", code)
	}
	code, body := upload(t, e, owner, alias, "a.png", pngBytes)
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	var m struct{ URL string }
	_ = json.Unmarshal([]byte(body), &m)
	if !strings.HasPrefix(m.URL, "/uploads/") || !strings.HasSuffix(m.URL, ".png") {
		t.Fatalf("url %q", m.URL)
	}
	resp, body2 := e.get(m.URL)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/png" || body2 != string(pngBytes) ||
		resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("serve: %d %s", resp.StatusCode, resp.Header)
	}
	if _, err := os.Stat(filepath.Join(e.cfg.DataDir, "uploads", filepath.Base(m.URL))); err != nil {
		t.Fatal(err)
	}
	if resp, _ := e.get("/uploads/..%2Fsecret"); resp.StatusCode != 404 {
		t.Fatal("path traversal")
	}
}

func TestMediaSizeLimit(t *testing.T) {
	e := newTestEnv(t, func(c *config.Config) { c.MaxUploadBytes = 100 })
	alias := e.createNote(nil, "x")
	if code, _ := upload(t, e, nil, alias, "big.png", append(pngBytes, make([]byte, 200)...)); code != 413 {
		t.Fatalf("oversized: %d", code)
	}
}

func TestDownloadMarkdown(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "# Weekly sync\nnotes")
	resp, body := e.get("/api/notes/" + alias + "/download.md")
	if resp.StatusCode != 200 || body != "# Weekly sync\nnotes" ||
		resp.Header.Get("Content-Disposition") != `attachment; filename="weekly-sync.md"` {
		t.Fatalf("%d %q %s", resp.StatusCode, body, resp.Header)
	}
}

func TestStoredContentFollowsEditsNotSuggestions(t *testing.T) {
	e := newTestEnv(t, func(c *config.Config) { c.RoomSaveEvery = 50 * time.Millisecond })
	alias := e.createNote(nil, "first")
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	waitContent := func(want string) {
		t.Helper()
		waitFor(t, "content "+want, func() bool {
			cur, err := e.srv.Store().NoteByID(context.Background(), n.ID)
			return err == nil && cur.Content == want
		})
	}
	waitContent("first")
	if _, err := e.srv.EditForTest(context.Background(), n.ID, "second"); err != nil {
		t.Fatal(err)
	}
	waitContent("second")
	e.do(nil, "POST", "/api/notes/"+alias+"/suggestions", map[string]any{"quote": "second", "proposed": "third"})
	time.Sleep(200 * time.Millisecond)
	waitContent("second")
}

func TestMissingUploadIsNotCached(t *testing.T) {
	e := newTestEnv(t)
	resp, err := http.Get(e.ts.URL + "/uploads/0123456789abcdef0123456789abcdef.png")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 404 || strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("%d, Cache-Control %q", resp.StatusCode, resp.Header.Get("Cache-Control"))
	}
}
