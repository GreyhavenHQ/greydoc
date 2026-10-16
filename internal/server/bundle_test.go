package server_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
)

func noteID(t *testing.T, e *testEnv, alias string) string {
	t.Helper()
	_, body := e.get("/api/notes/" + alias)
	var n struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(body), &n); err != nil || n.ID == "" {
		t.Fatalf("note %s: %s", alias, body)
	}
	return n.ID
}

func importBundle(t *testing.T, e *testEnv, name string, data []byte) (int, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	_ = mw.Close()
	resp, err := http.Post(e.ts.URL+"/api/notes/import", mw.FormDataContentType(), &buf)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func zipOf(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, data := range files {
		w, _ := zw.Create(name)
		_, _ = w.Write(data)
	}
	_ = zw.Close()
	return buf.Bytes()
}

func TestNoteBundleRoundTrip(t *testing.T) {
	ctx := context.Background()
	src := newTestEnv(t)
	code, body := src.do(nil, "POST", "/api/notes", map[string]any{
		"content": "# Trip\n", "alias": "bundle-src", "extra_aliases": []string{"old-id"},
		"created_at": "2021-03-04T10:00:00Z", "agent_policy": "edit",
	})
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	_, up := upload(t, src, nil, "bundle-src", "shot.png", pngBytes)
	var m struct{ URL string }
	_ = json.Unmarshal([]byte(up), &m)
	text := "# Trip\n\n![shot](" + m.URL + ")\n\n![remote](https://example.com/uploads/0123456789abcdef0123456789abcdef.png)\n"
	if _, err := src.srv.EditForTest(ctx, noteID(t, src, "bundle-src"), text); err != nil {
		t.Fatal(err)
	}

	resp, err := http.Get(src.ts.URL + "/api/notes/bundle-src/export.zip")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Content-Disposition"), "trip.zip") {
		t.Fatalf("%d %s", resp.StatusCode, resp.Header.Get("Content-Disposition"))
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		files[f.Name] = string(b)
	}
	stored := strings.TrimPrefix(m.URL, "/uploads/")
	if files["uploads/"+stored] != string(pngBytes) {
		t.Fatalf("upload missing from %v", keys(files))
	}
	md := files["trip.md"]
	if !strings.Contains(md, "](uploads/"+stored+")") || !strings.Contains(md, "https://example.com/uploads/") {
		t.Fatalf("markdown: %q", md)
	}
	var meta struct {
		Alias        string            `json:"alias"`
		ExtraAliases []string          `json:"extra_aliases"`
		AgentPolicy  string            `json:"agent_policy"`
		Uploads      map[string]string `json:"uploads"`
	}
	if err := json.Unmarshal([]byte(files["note.json"]), &meta); err != nil || meta.Alias != "bundle-src" || meta.AgentPolicy != "edit" ||
		len(meta.ExtraAliases) != 1 || meta.Uploads[stored] != "shot.png" {
		t.Fatalf("note.json: %s", files["note.json"])
	}

	dst := newTestEnv(t)
	code, body = importBundle(t, dst, "trip.zip", raw)
	if code != 201 {
		t.Fatalf("import: %d %s", code, body)
	}
	var got struct {
		Alias   string `json:"alias"`
		Renamed bool   `json:"renamed"`
	}
	_ = json.Unmarshal([]byte(body), &got)
	if got.Alias != "bundle-src" || got.Renamed {
		t.Fatalf("%s", body)
	}
	_, content := dst.get("/api/notes/bundle-src/download.md")
	if strings.Contains(content, stored) || !strings.Contains(content, "](/uploads/") || !strings.Contains(content, "https://example.com/uploads/") {
		t.Fatalf("imported text: %q", content)
	}
	newURL := content[strings.Index(content, "](/uploads/")+2:]
	newURL = newURL[:strings.IndexByte(newURL, ')')]
	img, err := http.Get(dst.ts.URL + newURL)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(img.Body)
	img.Body.Close()
	if !bytes.Equal(b, pngBytes) {
		t.Fatal("imported upload differs")
	}
	_, imported := dst.get("/api/notes/old-id")
	if !strings.Contains(imported, `"created_at":"2021-03-04T10:00:00`) || !strings.Contains(imported, `"agent_policy":"edit"`) {
		t.Fatalf("metadata: %s", imported)
	}

	code, body = importBundle(t, dst, "trip.zip", raw)
	if code != 201 || !strings.Contains(body, `"renamed":true`) || strings.Contains(body, `"alias":"bundle-src"`) {
		t.Fatalf("second import: %d %s", code, body)
	}
}

func TestNoteBundleImportChecks(t *testing.T) {
	e := newTestEnv(t)
	plain := zipOf(t, map[string][]byte{"notes.md": []byte("# Plain\n\n![a](uploads/a.png)\n"), "uploads/a.png": pngBytes})
	if code, body := importBundle(t, e, "plain.zip", plain); code != 201 || !strings.Contains(body, `"title":"Plain"`) {
		t.Fatalf("zip without note.json: %d %s", code, body)
	}
	two := zipOf(t, map[string][]byte{"a.md": []byte("a"), "b.md": []byte("b")})
	if code, _ := importBundle(t, e, "two.zip", two); code != 400 {
		t.Fatalf("two documents: %d", code)
	}
	html := zipOf(t, map[string][]byte{"a.md": []byte("a"), "uploads/x.png": []byte("<script>alert(1)</script>")})
	if code, _ := importBundle(t, e, "html.zip", html); code != 415 {
		t.Fatalf("html upload: %d", code)
	}
	if code, _ := importBundle(t, e, "junk.zip", []byte("not a zip")); code != 400 {
		t.Fatalf("junk: %d", code)
	}
}

func TestNoteBundleIgnoresGroups(t *testing.T) {
	e := newTestEnv(t)
	meta := []byte(`{"greydoc": 1, "alias": "old-bundle", "permissions": {"signed_in": "read", "groups": {"eng": "write"}}}`)
	if code, body := importBundle(t, e, "old.zip", zipOf(t, map[string][]byte{"note.json": meta, "old.md": []byte("# Old\n")})); code != 201 {
		t.Fatalf("import: %d %s", code, body)
	}
	_, perms := e.get("/api/notes/old-bundle/permissions")
	if strings.Contains(perms, "eng") || !strings.Contains(perms, `{"group":"_signed_in","level":"read"}`) {
		t.Fatalf("permissions: %s", perms)
	}
	id := noteID(t, e, "old-bundle")
	if err := e.srv.Store().SetGroupGrant(context.Background(), id, "eng", 2, nil); err != nil {
		t.Fatal(err)
	}
	resp, err := http.Get(e.ts.URL + "/api/notes/old-bundle/export.zip")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range zr.File {
		if f.Name == "note.json" {
			rc, _ := f.Open()
			b, _ := io.ReadAll(rc)
			rc.Close()
			if strings.Contains(string(b), "groups") || strings.Contains(string(b), "eng") {
				t.Fatalf("note.json: %s", b)
			}
		}
	}
}

func keys(m map[string]string) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	return out
}
