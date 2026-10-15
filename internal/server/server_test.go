package server_test

import (
	"strings"
	"testing"
)

func TestHealthz(t *testing.T) {
	e := newTestEnv(t)
	resp, body := e.get("/healthz")
	if resp.StatusCode != 200 || !strings.Contains(body, "ok") {
		t.Fatalf("healthz: %d %q", resp.StatusCode, body)
	}
}

func TestUnknownPathServesIndex(t *testing.T) {
	e := newTestEnv(t)
	resp, body := e.get("/some/note/path")
	if resp.StatusCode != 200 || !strings.Contains(body, `<div id="root">`) {
		t.Fatalf("spa fallback: %d %q", resp.StatusCode, body)
	}
	if resp.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("index must not be cached, got %q", resp.Header.Get("Cache-Control"))
	}
}

func TestHealthzReportsDatabaseFailure(t *testing.T) {
	e := newTestEnv(t)
	_ = e.srv.Store().Close()
	resp, body := e.get("/healthz")
	if resp.StatusCode != 503 || !strings.Contains(body, "database") {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
}
