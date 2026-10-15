// Package collab runs live Yjs rooms: one per open note, shared by websocket peers and server edits.
package collab

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/greyhavenhq/greydoc/internal/permission"
)

var ErrNoteNotFound = errors.New("note not found")

// RoomState is what a room loads: the last snapshot, updates logged after it, and seed text.
type RoomState struct {
	YState  []byte
	Updates [][]byte
	// Content seeds an empty document, for notes created through the API.
	Content string
	OwnerID string
	Clients []Client
}

// Client maps a Yjs client ID to the person and source behind it.
type Client struct {
	ClientID    uint64 `json:"client_id"`
	UserID      string `json:"user_id"`
	DisplayName string `json:"display_name"`
	Source      string `json:"source"`
}

type UpdateRecord struct {
	UserID   string
	Name     string
	Source   string
	ClientID uint64
	Data     []byte
	At       time.Time
}

type Store interface {
	LoadRoom(ctx context.Context, noteID string) (*RoomState, error)
	SaveRoom(ctx context.Context, noteID string, ystate []byte, text string) error
	AppendUpdates(ctx context.Context, noteID string, recs []UpdateRecord) error
	RegisterClient(ctx context.Context, noteID string, c Client) error
}

type Options struct {
	IdleGrace     time.Duration
	FlushInterval time.Duration
	SaveInterval  time.Duration
	// OnClosed runs after a room closed and saved.
	OnClosed func(noteID string)
}

type Hub struct {
	store   Store
	opts    Options
	mu      sync.Mutex
	rooms   map[string]*Room
	closing map[string]chan struct{}
}

func NewHub(st Store, opts Options) *Hub {
	if opts.IdleGrace == 0 {
		opts.IdleGrace = 10 * time.Second
	}
	if opts.FlushInterval == 0 {
		opts.FlushInterval = time.Second
	}
	if opts.SaveInterval == 0 {
		opts.SaveInterval = 15 * time.Second
	}
	return &Hub{store: st, opts: opts, rooms: map[string]*Room{}, closing: map[string]chan struct{}{}}
}

// acquire returns the note's room, loading it once. release MUST be called when done.
// slowRoom is how long opening or saving a note may take before it is logged.
const slowRoom = 2 * time.Second

func (h *Hub) acquire(ctx context.Context, noteID string) (*Room, func(), error) {
	start := time.Now()
	for {
		h.mu.Lock()
		if ch := h.closing[noteID]; ch != nil {
			h.mu.Unlock()
			select {
			case <-ch:
				if d := time.Since(start); d > slowRoom {
					slog.Warn("slow note open: waited for the room to close", "note", noteID, "waited", d)
				}
				continue
			case <-ctx.Done():
				return nil, nil, ctx.Err()
			}
		}
		r := h.rooms[noteID]
		if r == nil {
			r = newRoom(h, noteID)
			h.rooms[noteID] = r
			r.refs++
			h.mu.Unlock()
			loadStart := time.Now()
			err := r.load(ctx)
			if d := time.Since(loadStart); d > slowRoom {
				slog.Warn("slow note open: loading the room", "note", noteID, "took", d, "error", err)
			}
			close(r.ready)
			if err != nil {
				h.mu.Lock()
				r.refs--
				r.loadErr = err
				delete(h.rooms, noteID)
				h.mu.Unlock()
				return nil, nil, err
			}
			go r.loop()
			return r, h.releaser(r), nil
		}
		r.refs++
		if r.idleTimer != nil {
			r.idleTimer.Stop()
			r.idleTimer = nil
		}
		h.mu.Unlock()
		waitStart := time.Now()
		<-r.ready
		if d := time.Since(waitStart); d > slowRoom {
			slog.Warn("slow note open: waited for another request to load the room", "note", noteID, "waited", d)
		}
		if r.loadErr != nil {
			return nil, nil, r.loadErr
		}
		return r, h.releaser(r), nil
	}
}

func (h *Hub) releaser(r *Room) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			h.mu.Lock()
			defer h.mu.Unlock()
			r.refs--
			if r.refs == 0 && !r.closed {
				r.idleTimer = time.AfterFunc(h.opts.IdleGrace, func() { h.closeIdle(r) })
			}
		})
	}
}

func (h *Hub) closeIdle(r *Room) {
	h.mu.Lock()
	if r.refs > 0 || r.closed || h.rooms[r.noteID] != r {
		h.mu.Unlock()
		return
	}
	r.closed = true
	delete(h.rooms, r.noteID)
	done := make(chan struct{})
	h.closing[r.noteID] = done
	h.mu.Unlock()

	r.shutdown(true)

	h.mu.Lock()
	delete(h.closing, r.noteID)
	h.mu.Unlock()
	close(done)
	if h.opts.OnClosed != nil {
		h.opts.OnClosed(r.noteID)
	}
}

func (h *Hub) liveRoom(noteID string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[noteID]
	if r == nil || r.closed {
		return nil
	}
	return r
}

// LiveText returns the text of an open room.
func (h *Hub) LiveText(noteID string) (string, bool) {
	r := h.liveRoom(noteID)
	if r == nil {
		return "", false
	}
	<-r.ready
	if r.loadErr != nil {
		return "", false
	}
	return r.doc.text(), true
}

// Text returns the current text, opening the room if needed.
func (h *Hub) Text(ctx context.Context, noteID string) (string, error) {
	r, release, err := h.acquire(ctx, noteID)
	if err != nil {
		return "", err
	}
	defer release()
	return r.doc.text(), nil
}

// CloseNote tells peers why and closes the room without saving (the note is gone).
func (h *Hub) CloseNote(noteID, reason string) {
	h.mu.Lock()
	r := h.rooms[noteID]
	if r != nil {
		r.closed = true
		delete(h.rooms, noteID)
		if r.idleTimer != nil {
			r.idleTimer.Stop()
		}
	}
	h.mu.Unlock()
	if r == nil {
		return
	}
	<-r.ready
	r.broadcastApp(map[string]any{"type": reason})
	r.closeConns(websocket.StatusGoingAway, reason)
	r.shutdown(false)
}

// PermissionsChanged re-checks every connection of the note.
func (h *Hub) PermissionsChanged(noteID string) {
	if r := h.liveRoom(noteID); r != nil {
		<-r.ready
		r.recheckAccess()
	}
}

// Broadcast sends a JSON app event to every peer of an open note.
func (h *Hub) Broadcast(noteID string, event map[string]any) {
	if r := h.liveRoom(noteID); r != nil {
		<-r.ready
		r.broadcastApp(event)
	}
}

// Flush writes pending updates of one open note, or of every open note when noteID is empty.
func (h *Hub) Flush(noteID string) {
	h.mu.Lock()
	var rooms []*Room
	for id, r := range h.rooms {
		if noteID == "" || id == noteID {
			rooms = append(rooms, r)
		}
	}
	h.mu.Unlock()
	for _, r := range rooms {
		<-r.ready
		if r.loadErr == nil {
			r.flush()
		}
	}
}

// Shutdown saves and closes every room.
func (h *Hub) Shutdown(ctx context.Context) {
	h.mu.Lock()
	rooms := make([]*Room, 0, len(h.rooms))
	for id, r := range h.rooms {
		r.closed = true
		if r.idleTimer != nil {
			r.idleTimer.Stop()
		}
		rooms = append(rooms, r)
		delete(h.rooms, id)
	}
	h.mu.Unlock()
	for _, r := range rooms {
		<-r.ready
		if r.loadErr != nil {
			continue
		}
		r.closeConns(websocket.StatusGoingAway, "server shutting down")
		r.shutdown(true)
		if h.opts.OnClosed != nil {
			h.opts.OnClosed(r.noteID)
		}
	}
}

// Peer is an authenticated websocket participant.
type Peer struct {
	UserID string
	Name   string
	// TrustClientName keeps the name the browser sets in awareness (local mode).
	TrustClientName bool
	Authorize       func(ctx context.Context) (permission.Level, error)
}

// Serve runs one websocket connection until it closes.
func (h *Hub) Serve(ctx context.Context, ws *websocket.Conn, noteID string, p Peer) {
	ws.SetReadLimit(32 << 20)
	r, release, err := h.acquire(ctx, noteID)
	if err != nil {
		slog.Warn("room load failed", "note", noteID, "error", err)
		_ = ws.Close(websocket.StatusInternalError, "could not open note")
		return
	}
	defer release()
	level, err := p.Authorize(ctx)
	if err != nil || level < permission.Read {
		_ = ws.Close(websocket.StatusPolicyViolation, "forbidden")
		return
	}
	c := newConn(r, ws, p, level)
	c.run(ctx)
}

// Author identifies who a server-side edit is for.
type Author struct {
	UserID string
	Name   string
	Source string
}

// EditView is the document as an edit function sees it.
type EditView struct {
	Text string
	doc  *crdtDoc
}

// Resolve maps an encoded Yjs relative position to a byte offset in Text.
func (v EditView) Resolve(relPos []byte) (int, bool) {
	idx, ok := v.doc.resolveRelPos(relPos)
	if !ok {
		return 0, false
	}
	return byteOffset(v.Text, idx), true
}

// Edit applies fn's new text as a server transaction with a fresh client ID registered to author.
func (h *Hub) Edit(ctx context.Context, noteID string, a Author, fn func(EditView) (string, error)) (string, error) {
	r, release, err := h.acquire(ctx, noteID)
	if err != nil {
		return "", err
	}
	defer release()
	return r.edit(ctx, a, fn)
}

// Replace swaps one exact range as a server transaction. fn returns byte offsets into v.Text.
func (h *Hub) Replace(ctx context.Context, noteID string, a Author, fn func(EditView) (start, end int, repl string, err error)) (string, error) {
	r, release, err := h.acquire(ctx, noteID)
	if err != nil {
		return "", err
	}
	defer release()
	return r.replace(a, fn)
}

// Anchor finds a range with fn and returns Yjs relative positions for its start and end.
func (h *Hub) Anchor(ctx context.Context, noteID string, fn func(text string) (start, end int, err error)) (startRel, endRel []byte, quote string, err error) {
	r, release, err := h.acquire(ctx, noteID)
	if err != nil {
		return nil, nil, "", err
	}
	defer release()
	text := r.doc.text()
	start, end, err := fn(text)
	if err != nil {
		return nil, nil, "", err
	}
	if startRel, err = r.doc.relPos(utf16Offset(text, start), 0); err != nil {
		return nil, nil, "", err
	}
	if endRel, err = r.doc.relPos(utf16Offset(text, end), -1); err != nil {
		return nil, nil, "", err
	}
	return startRel, endRel, text[start:end], nil
}

// Resolve maps relative positions to byte offsets in the current text.
func (h *Hub) Resolve(ctx context.Context, noteID string, rels ...[]byte) (string, []int, []bool, error) {
	r, release, err := h.acquire(ctx, noteID)
	if err != nil {
		return "", nil, nil, err
	}
	defer release()
	view := EditView{Text: r.doc.text(), doc: r.doc}
	offs := make([]int, len(rels))
	oks := make([]bool, len(rels))
	for i, rel := range rels {
		offs[i], oks[i] = view.Resolve(rel)
	}
	return view.Text, offs, oks, nil
}

// Attribution returns the visible text split into runs by client ID.
func (h *Hub) Attribution(ctx context.Context, noteID string) ([]Run, error) {
	r, release, err := h.acquire(ctx, noteID)
	if err != nil {
		return nil, err
	}
	defer release()
	runs := r.doc.attribution()
	out := make([]Run, len(runs))
	for i, run := range runs {
		out[i] = Run{ClientID: run.clientID, Text: run.text}
	}
	return out, nil
}

type Run struct {
	ClientID uint64 `json:"client_id"`
	Text     string `json:"text"`
}
