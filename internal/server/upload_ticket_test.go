package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"
)

func postFile(t *testing.T, url, name string, data []byte) (int, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	_ = mw.Close()
	resp, err := http.Post(url, mw.FormDataContentType(), &buf)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestMCPOneTimeUpload(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "# Pics\n")
	s := e.mcp("")
	out, isErr := call(t, s, "create_upload", map[string]any{"note": alias, "filename": "chart.png"})
	if isErr {
		t.Fatal(out)
	}
	var ticket struct {
		UploadURL string `json:"upload_url"`
		Command   string `json:"command"`
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.Unmarshal([]byte(out), &ticket); err != nil || !strings.HasPrefix(ticket.UploadURL, e.ts.URL+"/api/uploads/") ||
		!strings.Contains(ticket.Command, "curl") || !strings.Contains(ticket.Command, ticket.UploadURL) || ticket.ExpiresAt == "" {
		t.Fatalf("ticket: %s", out)
	}

	if code, body := postFile(t, ticket.UploadURL, "page.html", []byte("<script>alert(1)</script>")); code != 415 {
		t.Fatalf("html accepted: %d %s", code, body)
	}
	code, body := postFile(t, ticket.UploadURL, "chart.png", pngBytes)
	if code != 201 {
		t.Fatalf("upload after a rejected file: %d %s", code, body)
	}
	var got struct {
		URL      string `json:"url"`
		Markdown string `json:"markdown"`
	}
	_ = json.Unmarshal([]byte(body), &got)
	if !strings.HasPrefix(got.URL, "/uploads/") || got.Markdown != "![chart.png]("+got.URL+")" {
		t.Fatalf("%s", body)
	}
	img, _ := http.Get(e.ts.URL + got.URL)
	data, _ := io.ReadAll(img.Body)
	img.Body.Close()
	if !bytes.Equal(data, pngBytes) {
		t.Fatal("stored file differs")
	}
	if code, _ := postFile(t, ticket.UploadURL, "again.png", pngBytes); code != 410 {
		t.Fatalf("ticket reused: %d", code)
	}
	if code, _ := postFile(t, e.ts.URL+"/api/uploads/gd_up_nosuchticket", "x.png", pngBytes); code != 410 {
		t.Fatalf("unknown ticket: %d", code)
	}
	media, _ := e.srv.Store().NoteMedia(context.Background(), noteID(t, e, alias))
	if len(media) != 1 || media[0].Filename != "chart.png" {
		t.Fatalf("media %+v", media)
	}
	_, audit := e.get("/api/audit?note=" + alias)
	if !strings.Contains(audit, `"kind":"media.upload"`) || !strings.Contains(audit, `"source":"agent"`) {
		t.Fatalf("audit: %s", audit)
	}

	e.do(nil, "PUT", "/api/notes/"+alias+"/agent-policy", map[string]string{"policy": "read"})
	if out, isErr := call(t, s, "create_upload", map[string]any{"note": alias}); !isErr {
		t.Fatalf("read-only agent got a ticket: %s", out)
	}
}

func TestOneTimeUploadNeedsNoSessionInOIDCMode(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner"})
	alias := e.createNote(owner, "pics")
	_, body := e.do(owner, "POST", "/api/tokens", map[string]string{"label": "agent"})
	var tok struct{ Token string }
	_ = json.Unmarshal([]byte(body), &tok)
	out, isErr := call(t, e.mcp(tok.Token), "create_upload", map[string]any{"note": alias, "filename": "./shot.png"})
	if isErr || !strings.Contains(out, `file=@./shot.png`) {
		t.Fatal(out)
	}
	var ticket struct {
		UploadURL string `json:"upload_url"`
	}
	_ = json.Unmarshal([]byte(out), &ticket)
	if code, body := postFile(t, ticket.UploadURL, "shot.png", pngBytes); code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	n, _ := e.srv.Store().NoteByAlias(context.Background(), alias)
	media, _ := e.srv.Store().NoteMedia(context.Background(), n.ID)
	if len(media) != 1 || media[0].UploadedBy == "" {
		t.Fatalf("%+v", media)
	}
}
