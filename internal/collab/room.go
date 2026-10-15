package collab

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type Room struct {
	hub    *Hub
	noteID string
	doc    *crdtDoc
	ready  chan struct{}
	stop   chan struct{}
	done   chan struct{}

	// Guarded by hub.mu.
	refs      int
	closed    bool
	idleTimer *time.Timer
	loadErr   error

	// editMu serializes server edits.
	editMu sync.Mutex

	// mu guards the fields below. Rule: never take the document lock while holding mu.
	mu        sync.Mutex
	conns     map[*conn]struct{}
	clients   map[uint64]Client
	owned     map[uint64]*conn
	origins   map[uint64]*serverOrigin
	awareness map[uint64]awState
	pending   []UpdateRecord
	dirty     bool
	unsub     func()
}

type awState struct {
	clock uint64
	state string
	conn  *conn
}

// serverOrigin marks updates made by server edits.
type serverOrigin struct {
	author   Author
	clientID uint64
}

func newRoom(h *Hub, noteID string) *Room {
	return &Room{hub: h, noteID: noteID, ready: make(chan struct{}), stop: make(chan struct{}), done: make(chan struct{}),
		conns: map[*conn]struct{}{}, clients: map[uint64]Client{}, owned: map[uint64]*conn{},
		origins: map[uint64]*serverOrigin{}, awareness: map[uint64]awState{}}
}

func randomClientID() uint64 {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return binary.BigEndian.Uint64(b[:])&(1<<53-1) | 1
}

func (r *Room) load(ctx context.Context) error {
	st, err := r.hub.store.LoadRoom(ctx, r.noteID)
	if err != nil {
		return err
	}
	r.doc = newCRDT(randomClientID())
	if len(st.YState) > 0 {
		if err := r.doc.apply(st.YState, nil); err != nil {
			return err
		}
	}
	for _, u := range st.Updates {
		if err := r.doc.apply(u, nil); err != nil {
			slog.Warn("skipping bad logged update", "note", r.noteID, "error", err)
		}
	}
	for _, c := range st.Clients {
		r.clients[c.ClientID] = c
	}
	r.unsub = r.doc.onUpdate(r.onUpdate)
	if r.doc.text() == "" && len(st.YState) == 0 && st.Content != "" {
		if _, err := r.edit(ctx, Author{UserID: st.OwnerID, Name: "", Source: "human"},
			func(EditView) (string, error) { return st.Content, nil }); err != nil {
			return err
		}
		r.flush()
		r.save()
	}
	return nil
}

// onUpdate runs inside the document's commit with its lock held.
func (r *Room) onUpdate(update []byte, origin any) {
	data := append([]byte(nil), update...)
	rec := UpdateRecord{Data: data, At: time.Now()}
	switch o := origin.(type) {
	case *conn:
		rec.UserID, rec.Name, rec.Source, rec.ClientID = o.peer.UserID, o.peer.Name, "human", o.primaryClient()
	case *serverOrigin:
		rec.UserID, rec.Name, rec.Source, rec.ClientID = o.author.UserID, o.author.Name, o.author.Source, o.clientID
	default:
		return
	}
	msg := encodeSyncUpdate(data)
	r.mu.Lock()
	r.pending = append(r.pending, rec)
	r.dirty = true
	for c := range r.conns {
		if c != origin {
			c.send(msg)
		}
	}
	r.mu.Unlock()
}

func (r *Room) loop() {
	defer close(r.done)
	flush := time.NewTicker(r.hub.opts.FlushInterval)
	save := time.NewTicker(r.hub.opts.SaveInterval)
	defer flush.Stop()
	defer save.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-flush.C:
			r.flush()
		case <-save.C:
			r.mu.Lock()
			dirty := r.dirty
			r.mu.Unlock()
			if dirty {
				r.flush()
				r.save()
			}
		}
	}
}

// flush writes pending updates, merging runs from the same client.
func (r *Room) flush() {
	r.mu.Lock()
	pending := r.pending
	r.pending = nil
	r.mu.Unlock()
	if len(pending) == 0 {
		return
	}
	var out []UpdateRecord
	for i := 0; i < len(pending); {
		j := i + 1
		for j < len(pending) && pending[j].ClientID == pending[i].ClientID && pending[j].UserID == pending[i].UserID &&
			pending[j].Source == pending[i].Source {
			j++
		}
		rec := pending[i]
		if j-i > 1 {
			datas := make([][]byte, 0, j-i)
			for _, p := range pending[i:j] {
				datas = append(datas, p.Data)
			}
			if merged, err := mergeUpdates(datas); err == nil {
				rec.Data = merged
				rec.At = pending[j-1].At
			} else {
				out = append(out, pending[i:j]...)
				i = j
				continue
			}
		}
		out = append(out, rec)
		i = j
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := r.hub.store.AppendUpdates(ctx, r.noteID, out); err != nil {
		slog.Error("append updates failed", "note", r.noteID, "error", err)
		r.mu.Lock()
		r.pending = append(out, r.pending...)
		r.mu.Unlock()
	}
}

func (r *Room) save() {
	r.mu.Lock()
	r.dirty = false
	r.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := r.hub.store.SaveRoom(ctx, r.noteID, r.doc.state(), r.doc.text()); err != nil {
		slog.Error("save room failed", "note", r.noteID, "error", err)
		r.mu.Lock()
		r.dirty = true
		r.mu.Unlock()
	}
}

// shutdown stops the room loop and, if persist, writes everything out.
func (r *Room) shutdown(persist bool) {
	if r.loadErr != nil || r.doc == nil {
		return
	}
	close(r.stop)
	<-r.done
	if r.unsub != nil {
		r.unsub()
	}
	if persist {
		r.flush()
		r.mu.Lock()
		dirty := r.dirty
		r.mu.Unlock()
		if dirty {
			r.save()
		}
	}
}

func (r *Room) registerClient(c Client) {
	r.mu.Lock()
	r.clients[c.ClientID] = c
	r.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := r.hub.store.RegisterClient(ctx, r.noteID, c); err != nil {
		slog.Error("register client failed", "note", r.noteID, "error", err)
	}
}

func (r *Room) edit(_ context.Context, a Author, fn func(EditView) (string, error)) (string, error) {
	r.editMu.Lock()
	defer r.editMu.Unlock()
	cid := randomClientID()
	var view EditView
	update, _, newText, err := editFrom(r.doc.state(), cid, func(d *crdtDoc) (string, error) {
		view = EditView{Text: d.text(), doc: d}
		return fn(view)
	})
	if err != nil {
		return "", err
	}
	if update == nil {
		return r.doc.text(), nil
	}
	r.registerClient(Client{ClientID: cid, UserID: a.UserID, DisplayName: a.Name, Source: a.Source})
	if err := r.doc.apply(update, &serverOrigin{author: a, clientID: cid}); err != nil {
		return "", err
	}
	_ = newText
	return r.doc.text(), nil
}

func (r *Room) replace(a Author, fn func(EditView) (int, int, string, error)) (string, error) {
	r.editMu.Lock()
	defer r.editMu.Unlock()
	cid := randomClientID()
	update, err := replaceFrom(r.doc.state(), cid, func(d *crdtDoc) (int, int, string, error) {
		return fn(EditView{Text: d.text(), doc: d})
	})
	if err != nil {
		return "", err
	}
	if update == nil {
		return r.doc.text(), nil
	}
	r.registerClient(Client{ClientID: cid, UserID: a.UserID, DisplayName: a.Name, Source: a.Source})
	if err := r.doc.apply(update, &serverOrigin{author: a, clientID: cid}); err != nil {
		return "", err
	}
	return r.doc.text(), nil
}

func (r *Room) broadcastApp(event map[string]any) {
	b, _ := json.Marshal(event)
	msg := encodeAppMessage(b)
	r.mu.Lock()
	defer r.mu.Unlock()
	for c := range r.conns {
		c.send(msg)
	}
}

func (r *Room) snapshotConns() []*conn {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*conn, 0, len(r.conns))
	for c := range r.conns {
		out = append(out, c)
	}
	return out
}

func (r *Room) closeConns(code websocket.StatusCode, reason string) {
	for _, c := range r.snapshotConns() {
		c.close(code, reason)
	}
}

func (r *Room) recheckAccess() {
	for _, c := range r.snapshotConns() {
		c.recheck()
	}
}

func (r *Room) addConn(c *conn) {
	r.mu.Lock()
	r.conns[c] = struct{}{}
	r.mu.Unlock()
}

// removeConn drops the connection and tells the others its cursors are gone.
func (r *Room) removeConn(c *conn) {
	r.mu.Lock()
	delete(r.conns, c)
	var gone []awarenessEntry
	for id, st := range r.awareness {
		if st.conn == c {
			gone = append(gone, awarenessEntry{clientID: id, clock: st.clock + 1, state: "null"})
			delete(r.awareness, id)
		}
	}
	for id, owner := range r.owned {
		if owner == c {
			delete(r.owned, id)
		}
	}
	if len(gone) > 0 {
		msg := encodeAwarenessMessage(encodeAwareness(gone))
		for o := range r.conns {
			o.send(msg)
		}
	}
	r.mu.Unlock()
}
