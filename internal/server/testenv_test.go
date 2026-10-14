package server_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/greyhavenhq/greydoc/internal/config"
	"github.com/greyhavenhq/greydoc/internal/server"
)

type testEnv struct {
	t   *testing.T
	cfg config.Config
	srv *server.Server
	ts  *httptest.Server
}

func newTestEnv(t *testing.T, mutate ...func(*config.Config)) *testEnv {
	t.Helper()
	dir := t.TempDir()
	cfg := config.FromEnv()
	cfg.DatabaseURL = filepath.Join(dir, "greydoc.db")
	cfg.DataDir = filepath.Join(dir, "data")
	cfg.SecretFile = filepath.Join(dir, "secret")
	cfg.OIDCIssuer = ""
	cfg.LLMBaseURL = ""
	for _, m := range mutate {
		m(&cfg)
	}
	srv, err := server.Open(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		ts.Close()
		srv.Close()
	})
	return &testEnv{t: t, cfg: cfg, srv: srv, ts: ts}
}

func (e *testEnv) get(path string, header ...string) (*http.Response, string) {
	e.t.Helper()
	req, err := http.NewRequest(http.MethodGet, e.ts.URL+path, nil)
	if err != nil {
		e.t.Fatal(err)
	}
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

// do sends a request with an optional JSON body through client c (nil means no cookies).
func (e *testEnv) do(c *http.Client, method, path string, body any, header ...string) (int, string) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, e.ts.URL+path, rd)
	if err != nil {
		e.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	if c == nil {
		c = http.DefaultClient
	}
	resp, err := c.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func (e *testEnv) createNote(c *http.Client, content string) string {
	e.t.Helper()
	code, body := e.do(c, "POST", "/api/notes", map[string]string{"content": content})
	if code != 201 {
		e.t.Fatalf("create note: %d %s", code, body)
	}
	var n struct {
		Alias string `json:"alias"`
	}
	_ = json.Unmarshal([]byte(body), &n)
	return n.Alias
}
