package collab

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/greyhavenhq/greydoc/internal/permission"
)

type memStore struct {
	mu      sync.Mutex
	notes   map[string]*RoomState
	saves   map[string]int
	updates map[string][]UpdateRecord
	clients map[string]map[uint64]Client
}

func newMemStore() *memStore {
	return &memStore{notes: map[string]*RoomState{}, saves: map[string]int{}, updates: map[string][]UpdateRecord{},
		clients: map[string]map[uint64]Client{}}
}

func (m *memStore) LoadRoom(_ context.Context, noteID string) (*RoomState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.notes[noteID]
	if !ok {
		return nil, ErrNoteNotFound
	}
	cp := *st
	for _, u := range m.updates[noteID] {
		cp.Updates = append(cp.Updates, u.Data)
	}
	for _, c := range m.clients[noteID] {
		cp.Clients = append(cp.Clients, c)
	}
	return &cp, nil
}

func (m *memStore) SaveRoom(_ context.Context, noteID string, ystate []byte, text string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.notes[noteID]
	st.YState = ystate
	st.Content = text
	m.saves[noteID]++
	return nil
}

func (m *memStore) AppendUpdates(_ context.Context, noteID string, recs []UpdateRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.updates[noteID] = append(m.updates[noteID], recs...)
	return nil
}

func (m *memStore) RegisterClient(_ context.Context, noteID string, c Client) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.clients[noteID] == nil {
		m.clients[noteID] = map[uint64]Client{}
	}
	m.clients[noteID][c.ClientID] = c
	return nil
}

func (m *memStore) savedText(noteID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.notes[noteID].Content
}

// testHub serves /ws/<note>?user=<name>; levels maps user to the level Authorize returns.
type testHub struct {
	t      *testing.T
	hub    *Hub
	store  *memStore
	ts     *httptest.Server
	mu     sync.Mutex
	levels map[string]permission.Level
}

func newTestHub(t *testing.T, grace time.Duration) *testHub {
	th := &testHub{t: t, store: newMemStore(), levels: map[string]permission.Level{}}
	th.hub = NewHub(th.store, Options{IdleGrace: grace, FlushInterval: 20 * time.Millisecond, SaveInterval: time.Hour})
	th.ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		noteID := strings.TrimPrefix(r.URL.Path, "/ws/")
		user := r.URL.Query().Get("user")
		if user == "" {
			user = "anon"
		}
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		th.hub.Serve(r.Context(), ws, noteID, Peer{
			UserID: user, Name: strings.ToUpper(user),
			Authorize: func(context.Context) (permission.Level, error) {
				th.mu.Lock()
				defer th.mu.Unlock()
				l, ok := th.levels[user]
				if !ok {
					return permission.Write, nil
				}
				return l, nil
			},
		})
	}))
	t.Cleanup(func() {
		th.ts.Close()
		th.hub.Shutdown(context.Background())
	})
	return th
}

func (th *testHub) setLevel(user string, l permission.Level) {
	th.mu.Lock()
	th.levels[user] = l
	th.mu.Unlock()
}

func (th *testHub) addNote(id, content string) {
	th.store.mu.Lock()
	th.store.notes[id] = &RoomState{Content: content, OwnerID: "owner"}
	th.store.mu.Unlock()
}

// peer is a minimal y-websocket client built on this package's codec.
type peer struct {
	t      *testing.T
	ws     *websocket.Conn
	doc    *crdtDoc
	cid    uint64
	mu     sync.Mutex
	app    []map[string]any
	closed chan struct{}
	synced chan struct{}
}

func (th *testHub) connect(noteID, user string, cid uint64) *peer {
	th.t.Helper()
	url := "ws" + strings.TrimPrefix(th.ts.URL, "http") + "/ws/" + noteID + "?user=" + user
	ws, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		th.t.Fatal(err)
	}
	ws.SetReadLimit(-1)
	p := &peer{t: th.t, ws: ws, doc: newCRDT(cid), cid: cid, closed: make(chan struct{}), synced: make(chan struct{})}
	go p.read()
	p.send(encodeSyncStep1(p.doc.stateVector()))
	th.t.Cleanup(func() { ws.CloseNow() })
	select {
	case <-p.synced:
	case <-p.closed:
	case <-time.After(5 * time.Second):
		th.t.Fatal("no sync step 2")
	}
	return p
}

func (p *peer) send(msg []byte) {
	_ = p.ws.Write(context.Background(), websocket.MessageBinary, msg)
}

func (p *peer) read() {
	defer close(p.closed)
	var once sync.Once
	for {
		_, b, err := p.ws.Read(context.Background())
		if err != nil {
			return
		}
		r := &reader{buf: b}
		typ, _ := r.varUint()
		switch typ {
		case msgSync:
			st, _ := r.varUint()
			data, _ := r.varBytes()
			switch st {
			case syncStep1:
				up, _ := p.doc.diff(data)
				p.send(encodeSyncStep2(up))
			case syncStep2, syncUpdate:
				_ = p.doc.apply(data, "remote")
				if st == syncStep2 {
					once.Do(func() { close(p.synced) })
				}
			}
		case msgApp:
			data, _ := r.varBytes()
			var ev map[string]any
			_ = json.Unmarshal(data, &ev)
			p.mu.Lock()
			p.app = append(p.app, ev)
			p.mu.Unlock()
		}
	}
}

// typeText replaces the peer's text and sends the change.
func (p *peer) typeText(text string) {
	up, err := p.doc.editAs(p.cid, text)
	if err != nil {
		p.t.Fatal(err)
	}
	_ = p.doc.apply(up, nil)
	p.send(encodeSyncUpdate(up))
}

func (p *peer) appEvents() []map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]map[string]any(nil), p.app...)
}

func eventually(t *testing.T, what string, cond func() bool) {
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
