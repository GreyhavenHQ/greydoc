package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/greyhavenhq/greydoc/internal/config"
)

// Two servers on one database, as during a rolling deploy, must not lose each other's edits.
func TestOverlappingServersKeepBothEdits(t *testing.T) {
	ctx := context.Background()
	old := newTestEnv(t)
	shared := func(c *config.Config) {
		c.DatabaseURL, c.DataDir, c.SecretFile = old.cfg.DatabaseURL, old.cfg.DataDir, old.cfg.SecretFile
	}
	alias := old.createNote(nil, "base")
	_, body := old.get("/api/notes/" + alias)
	var n struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(body), &n)

	next := newTestEnv(t, shared)
	if _, err := old.srv.TextForTest(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := next.srv.TextForTest(ctx, n.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := old.srv.EditForTest(ctx, n.ID, "base\nfrom old"); err != nil {
		t.Fatal(err)
	}
	if _, err := next.srv.EditForTest(ctx, n.ID, "from next\nbase"); err != nil {
		t.Fatal(err)
	}
	old.ts.Close()
	old.srv.Close()
	next.ts.Close()
	next.srv.Close()

	after := newTestEnv(t, shared)
	text, err := after.srv.TextForTest(ctx, n.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "from old") || !strings.Contains(text, "from next") {
		t.Fatalf("lost an edit: %q", text)
	}
}
