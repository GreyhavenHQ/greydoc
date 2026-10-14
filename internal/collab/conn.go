package collab

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/greyhavenhq/greydoc/internal/permission"
)

type conn struct {
	room  *Room
	ws    *websocket.Conn
	peer  Peer
	level atomic.Int32
	out   chan []byte

	closeOnce sync.Once
	closed    chan struct{}
	cid       atomic.Uint64
}

func newConn(r *Room, ws *websocket.Conn, p Peer, l permission.Level) *conn {
	c := &conn{room: r, ws: ws, peer: p, out: make(chan []byte, 512), closed: make(chan struct{})}
	c.level.Store(int32(l))
	return c
}

func (c *conn) canWrite() bool { return permission.Level(c.level.Load()) >= permission.Write }

func (c *conn) primaryClient() uint64 { return c.cid.Load() }

// send queues a message. A peer that cannot keep up is disconnected.
func (c *conn) send(msg []byte) {
	select {
	case c.out <- msg:
	case <-c.closed:
	default:
		go c.close(websocket.StatusPolicyViolation, "too slow")
	}
}

func (c *conn) close(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		close(c.closed)
		go func() {
			// Let the writer drain queued messages, such as a final app event, before closing.
			time.Sleep(50 * time.Millisecond)
			_ = c.ws.Close(code, reason)
		}()
	})
}

func (c *conn) sendApp(event map[string]any) {
	b, _ := json.Marshal(event)
	c.send(encodeAppMessage(b))
}

func (c *conn) accessEvent() map[string]any {
	return map[string]any{"type": "access", "level": permission.Level(c.level.Load()).String()}
}

func (c *conn) run(ctx context.Context) {
	r := c.room
	r.addConn(c)
	defer r.removeConn(c)

	c.sendApp(c.accessEvent())
	c.send(encodeSyncStep1(r.doc.stateVector()))
	r.mu.Lock()
	var states []awarenessEntry
	for id, st := range r.awareness {
		states = append(states, awarenessEntry{clientID: id, clock: st.clock, state: st.state})
	}
	r.mu.Unlock()
	if len(states) > 0 {
		c.send(encodeAwarenessMessage(encodeAwareness(states)))
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go c.writeLoop(ctx)
	for {
		_, data, err := c.ws.Read(ctx)
		if err != nil {
			c.close(websocket.StatusNormalClosure, "")
			return
		}
		if err := c.handle(data); err != nil {
			slog.Debug("bad message", "note", r.noteID, "user", c.peer.UserID, "error", err)
		}
	}
}

func (c *conn) writeLoop(ctx context.Context) {
	for {
		select {
		case msg := <-c.out:
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.ws.Write(wctx, websocket.MessageBinary, msg)
			cancel()
			if err != nil {
				c.close(websocket.StatusGoingAway, "write failed")
				return
			}
		case <-c.closed:
			for {
				select {
				case msg := <-c.out:
					wctx, cancel := context.WithTimeout(ctx, time.Second)
					_ = c.ws.Write(wctx, websocket.MessageBinary, msg)
					cancel()
				default:
					return
				}
			}
		case <-ctx.Done():
			return
		}
	}
}

func (c *conn) handle(data []byte) error {
	m, err := decodeMessage(data)
	if err != nil {
		return err
	}
	r := c.room
	switch m.typ {
	case msgSync:
		switch m.syncType {
		case syncStep1:
			diff, err := r.doc.diff(m.data)
			if err != nil {
				return err
			}
			c.send(encodeSyncStep2(diff))
		case syncStep2, syncUpdate:
			if !c.canWrite() || len(m.data) == 0 {
				return nil
			}
			return c.applyUpdate(m.data)
		}
	case msgAwareness:
		return c.handleAwareness(m.data)
	case msgQueryAw:
		r.mu.Lock()
		var states []awarenessEntry
		for id, st := range r.awareness {
			states = append(states, awarenessEntry{clientID: id, clock: st.clock, state: st.state})
		}
		r.mu.Unlock()
		c.send(encodeAwarenessMessage(encodeAwareness(states)))
	}
	return nil
}

type forgedError struct{ clientID uint64 }

func (e forgedError) Error() string { return "update writes under a client ID owned by someone else" }

// applyUpdate checks that every client ID the update extends belongs to this connection.
func (c *conn) applyUpdate(update []byte) error {
	if err := validUpdate(update); err != nil {
		return err
	}
	ranges, err := updateClockRanges(update)
	if err != nil {
		return err
	}
	r := c.room
	docSV := r.doc.svMap()
	var claims []Client
	r.mu.Lock()
	for cid, cr := range ranges {
		if cr.end <= docSV[cid] {
			continue
		}
		if owner, ok := r.owned[cid]; ok {
			if owner != c {
				r.mu.Unlock()
				return forgedError{cid}
			}
			continue
		}
		if reg, ok := r.clients[cid]; ok && (reg.UserID != c.peer.UserID || reg.Source != "human") {
			r.mu.Unlock()
			return forgedError{cid}
		}
		if _, known := docSV[cid]; known {
			if _, ok := r.clients[cid]; !ok {
				// Present in the document but never registered: only the server writes those.
				r.mu.Unlock()
				return forgedError{cid}
			}
		}
		r.owned[cid] = c
		if _, ok := r.clients[cid]; !ok {
			claims = append(claims, Client{ClientID: cid, UserID: c.peer.UserID, DisplayName: c.peer.Name, Source: "human"})
		}
		c.cid.CompareAndSwap(0, cid)
	}
	r.mu.Unlock()
	for _, cl := range claims {
		r.registerClient(cl)
	}
	return r.doc.apply(update, c)
}

func (c *conn) handleAwareness(data []byte) error {
	entries, err := decodeAwareness(data)
	if err != nil {
		return err
	}
	r := c.room
	r.mu.Lock()
	out := entries[:0]
	for _, e := range entries {
		if prev, ok := r.awareness[e.clientID]; ok && prev.conn != c {
			continue
		}
		if e.state == "null" {
			delete(r.awareness, e.clientID)
		} else {
			e.state = c.normalizeState(e.state)
			r.awareness[e.clientID] = awState{clock: e.clock, state: e.state, conn: c}
		}
		out = append(out, e)
	}
	if len(out) > 0 {
		msg := encodeAwarenessMessage(encodeAwareness(out))
		for o := range r.conns {
			if o != c {
				o.send(msg)
			}
		}
	}
	r.mu.Unlock()
	return nil
}

// normalizeState replaces the user name the browser claims with the authenticated one.
func (c *conn) normalizeState(state string) string {
	if c.peer.TrustClientName {
		return state
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(state), &m); err != nil {
		return state
	}
	user, _ := m["user"].(map[string]any)
	if user == nil {
		user = map[string]any{}
	}
	user["name"] = c.peer.Name
	user["id"] = c.peer.UserID
	m["user"] = user
	b, err := json.Marshal(m)
	if err != nil {
		return state
	}
	return string(b)
}

func (c *conn) recheck() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	l, err := c.peer.Authorize(ctx)
	if err != nil {
		slog.Warn("access recheck failed", "error", err)
		return
	}
	if l < permission.Read {
		c.level.Store(int32(permission.Deny))
		c.sendApp(map[string]any{"type": "access", "level": "deny"})
		c.close(websocket.StatusPolicyViolation, "access revoked")
		return
	}
	if old := permission.Level(c.level.Swap(int32(l))); old != l {
		c.sendApp(c.accessEvent())
	}
}
