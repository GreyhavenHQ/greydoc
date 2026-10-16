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

// dialClose connects and returns the close code the server sends at once. A refused note is closed, not failed,
// so browsers do not slow down later connections to the server.
func dialClose(t *testing.T, url string, header http.Header) websocket.StatusCode {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		code := 0
		if resp != nil {
			code = resp.StatusCode
		}
		t.Fatalf("dial failed with HTTP %d: %v", code, err)
	}
	defer ws.CloseNow()
	_, _, err = ws.Read(ctx)
	return websocket.CloseStatus(err)
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
		if code := dialClose(t, e.wsURL()+"/"+alias, h); code != 4401 {
			t.Fatalf("%d", code)
		}
	})
	t.Run("signed out", func(t *testing.T) {
		if code := dialClose(t, e.wsURL()+"/"+alias, nil); code != 4401 {
			t.Fatalf("%d", code)
		}
	})
	t.Run("unknown note", func(t *testing.T) {
		if code := dialClose(t, e.wsURL()+"/does-not-exist", cookieHeader(e, owner)); code != 4404 {
			t.Fatalf("%d", code)
		}
	})
	t.Run("no read permission", func(t *testing.T) {
		if code := dialClose(t, e.wsURL()+"/"+alias, cookieHeader(e, bob)); code != 4403 {
			t.Fatalf("%d", code)
		}
	})
	t.Run("note in the trash", func(t *testing.T) {
		gone := e.createNote(owner, "old")
		e.do(owner, "DELETE", "/api/notes/"+gone, nil)
		if code := dialClose(t, e.wsURL()+"/"+gone, cookieHeader(e, owner)); code != 4410 {
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

func TestGuestCanCommentAndEdit(t *testing.T) {
	e, idp := newOIDCEnv(t)
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner"})
	alias := e.createNote(owner, "alpha\n")
	if code, b := e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/groups/_everyone", map[string]string{"level": "comment"}); code != 200 {
		t.Fatalf("%d %s", code, b)
	}
	if code, b := e.do(nil, "POST", "/api/notes/"+alias+"/comments", map[string]any{"quote": "alpha", "body": "From a guest"}); code != 201 {
		t.Fatalf("guest comment: %d %s", code, b)
	}
	if code, b := e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/groups/_everyone", map[string]string{"level": "write"}); code != 200 {
		t.Fatalf("%d %s", code, b)
	}
	d := newYgoClient(t, e, alias)
	waitFor(t, "seed", func() bool { return ytext(d) == "alpha\n" })
	yinsert(d, 0, "guest\n")
	waitFor(t, "guest edit", func() bool {
		_, body := e.do(owner, "GET", "/api/notes/"+alias+"/content", nil)
		return body == "guest\nalpha\n"
	})
}
