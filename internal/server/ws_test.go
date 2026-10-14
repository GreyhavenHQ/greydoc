package server_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Deln0r/ygo"
	ygoclient "github.com/Deln0r/ygo/client"
	"github.com/coder/websocket"

	"github.com/greyhavenhq/greydoc/internal/config"
)

func (e *testEnv) wsURL() string { return "ws" + strings.TrimPrefix(e.ts.URL, "http") + "/ws" }

func dialStatus(t *testing.T, url string, header http.Header) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: header})
	if err == nil {
		ws.CloseNow()
		return 101
	}
	if resp == nil {
		t.Fatalf("dial: %v", err)
	}
	return resp.StatusCode
}

func cookieHeader(e *testEnv, c *http.Client) http.Header {
	h := http.Header{}
	req, _ := http.NewRequest("GET", e.ts.URL, nil)
	for _, ck := range c.Jar.Cookies(req.URL) {
		h.Add("Cookie", ck.Name+"="+ck.Value)
	}
	return h
}

func TestWebsocketGateway(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner"})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	alias := e.createNote(owner, "secret")
	e.do(owner, "DELETE", "/api/notes/"+alias+"/permissions/groups/_signed_in", nil)

	t.Run("invalid session", func(t *testing.T) {
		h := http.Header{"Cookie": {"greydoc_session=bogus"}}
		if code := dialStatus(t, e.wsURL()+"/"+alias, h); code != 401 {
			t.Fatalf("%d", code)
		}
	})
	t.Run("unknown note", func(t *testing.T) {
		if code := dialStatus(t, e.wsURL()+"/does-not-exist", cookieHeader(e, owner)); code != 404 {
			t.Fatalf("%d", code)
		}
	})
	t.Run("no read permission", func(t *testing.T) {
		if code := dialStatus(t, e.wsURL()+"/"+alias, cookieHeader(e, bob)); code != 403 {
			t.Fatalf("%d", code)
		}
	})
	t.Run("owner connects", func(t *testing.T) {
		if code := dialStatus(t, e.wsURL()+"/"+alias, cookieHeader(e, owner)); code != 101 {
			t.Fatalf("%d", code)
		}
	})
	t.Run("cross-origin refused", func(t *testing.T) {
		h := cookieHeader(e, owner)
		h.Set("Origin", "https://evil.example")
		if code := dialStatus(t, e.wsURL()+"/"+alias, h); code != 403 {
			t.Fatalf("%d", code)
		}
	})
}

func newYgoClient(t *testing.T, e *testEnv, alias string) *ygo.Doc {
	t.Helper()
	d := ygo.NewDoc()
	c, err := ygoclient.New(ygoclient.Options{URL: e.wsURL(), DocName: alias, Doc: d})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	waitFor(t, "sync", c.Synced)
	return d
}

func ytext(d *ygo.Doc) string {
	txt := ygo.NewText(d, "content")
	txn := d.ReadTxn()
	defer txn.Close()
	return txt.String()
}

func yinsert(d *ygo.Doc, at uint64, s string) {
	txt := ygo.NewText(d, "content")
	txn := d.WriteTxn()
	_ = txt.Insert(txn, at, s)
	txn.Commit()
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestYgoClientsConverge(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "# Shared\n")
	a := newYgoClient(t, e, alias)
	b := newYgoClient(t, e, alias)
	waitFor(t, "seed on a", func() bool { return ytext(a) == "# Shared\n" })
	yinsert(a, uint64(len("# Shared\n")), "from a\n")
	yinsert(b, 0, "from b\n")
	want := "from b\n# Shared\nfrom a\n"
	waitFor(t, "convergence", func() bool { return ytext(a) == want && ytext(b) == want })

	// note.service spec: content comes from the live room while it is open.
	_, body := e.get("/api/notes/" + alias + "/content")
	if body != want {
		t.Fatalf("live content %q", body)
	}
}

func TestRoomPersistsToDatabase(t *testing.T) {
	e := newTestEnv(t, func(c *config.Config) { c.RoomSaveEvery = 50 * time.Millisecond })
	alias := e.createNote(nil, "")
	a := newYgoClient(t, e, alias)
	yinsert(a, 0, "# Title from editor\nbody")
	waitFor(t, "stored", func() bool {
		n, err := e.srv.Store().NoteByAlias(context.Background(), alias)
		return err == nil && n.Content == "# Title from editor\nbody" && n.Title == "Title from editor"
	})
}
