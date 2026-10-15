package server_test

import (
	"context"
	"net/http"
	"regexp"
	"testing"
	"time"

	"github.com/coder/websocket"
)

var serverTiming = regexp.MustCompile(`^app;dur=\d+(\.\d+)?$`)

func TestResponsesCarryServerTiming(t *testing.T) {
	e := newTestEnv(t)
	alias := e.createNote(nil, "timed")
	resp, _ := e.get("/api/notes/" + alias)
	if got := resp.Header.Get("Server-Timing"); !serverTiming.MatchString(got) {
		t.Fatalf("api Server-Timing %q", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, wsResp, err := websocket.Dial(ctx, e.wsURL()+"/"+alias, &websocket.DialOptions{HTTPHeader: http.Header{}})
	if err != nil {
		t.Fatalf("websocket through the timing wrapper: %v", err)
	}
	defer ws.CloseNow()
	if got := wsResp.Header.Get("Server-Timing"); !serverTiming.MatchString(got) {
		t.Fatalf("handshake Server-Timing %q", got)
	}
}
