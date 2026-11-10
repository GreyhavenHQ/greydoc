package server_test

import (
	"encoding/json"
	"testing"
)

func mePrefs(t *testing.T, body string) map[string]string {
	t.Helper()
	var me struct {
		Prefs map[string]string `json:"prefs"`
	}
	if err := json.Unmarshal([]byte(body), &me); err != nil {
		t.Fatal(err)
	}
	return me.Prefs
}

func TestSetPrefs(t *testing.T) {
	e, idp := newOIDCEnv(t)
	if code, _ := e.do(nil, "PATCH", "/api/me/prefs", map[string]string{"live_style": "document"}); code != 401 {
		t.Fatalf("anonymous: %d", code)
	}
	c := e.login(idp, map[string]any{"sub": "u-1", "preferred_username": "alice"})
	if _, body := e.do(c, "GET", "/api/me", nil); len(mePrefs(t, body)) != 0 {
		t.Fatalf("default prefs: %s", body)
	}
	if code, body := e.do(c, "PATCH", "/api/me/prefs", map[string]string{"default_mode": "live", "live_style": "document"}); code != 200 {
		t.Fatalf("set: %d %s", code, body)
	}
	if code, body := e.do(c, "PATCH", "/api/me/prefs", map[string]string{"default_mode": "preview"}); code != 200 {
		t.Fatalf("merge: %d %s", code, body)
	}
	_, body := e.do(c, "GET", "/api/me", nil)
	if p := mePrefs(t, body); p["default_mode"] != "preview" || p["live_style"] != "document" {
		t.Fatalf("prefs: %s", body)
	}
	for _, bad := range []map[string]string{{"live_style": "fancy"}, {"theme": "dark"}, {"default_mode": "both"}} {
		if code, _ := e.do(c, "PATCH", "/api/me/prefs", bad); code != 400 {
			t.Fatalf("%v: %d", bad, code)
		}
	}
	if code, _ := e.do(c, "PATCH", "/api/me/prefs", map[string]string{"live_style": ""}); code != 200 {
		t.Fatal("clear")
	}
	_, body = e.do(c, "GET", "/api/me", nil)
	if _, ok := mePrefs(t, body)["live_style"]; ok {
		t.Fatalf("cleared: %s", body)
	}
}

func TestSetPrefsLocalMode(t *testing.T) {
	e := newTestEnv(t)
	if code, body := e.do(nil, "PATCH", "/api/me/prefs", map[string]string{"default_mode": "editor"}); code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	_, body := e.do(nil, "GET", "/api/me", nil)
	if mePrefs(t, body)["default_mode"] != "editor" {
		t.Fatal(body)
	}
}
