package collab

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/greyhavenhq/greydoc/internal/permission"
)

func TestTwoPeersConverge(t *testing.T) {
	th := newTestHub(t, time.Minute)
	th.addNote("n1", "")
	a := th.connect("n1", "alice", 1)
	b := th.connect("n1", "bob", 2)
	a.typeText("hello")
	eventually(t, "b sees a", func() bool { return b.doc.text() == "hello" })
	b.typeText("hello world")
	eventually(t, "a sees b", func() bool { return a.doc.text() == "hello world" })
}

func TestLateJoinerCatchesUp(t *testing.T) {
	th := newTestHub(t, time.Minute)
	th.addNote("n1", "seed\n")
	a := th.connect("n1", "alice", 1)
	if a.doc.text() != "seed\n" {
		t.Fatalf("seed not loaded: %q", a.doc.text())
	}
	a.typeText("seed\nmore")
	eventually(t, "hub has text", func() bool { txt, _ := th.hub.LiveText("n1"); return txt == "seed\nmore" })
	c := th.connect("n1", "carol", 3)
	if c.doc.text() != "seed\nmore" {
		t.Fatalf("late joiner: %q", c.doc.text())
	}
}

func TestRoomCreatedOnce(t *testing.T) {
	th := newTestHub(t, time.Minute)
	th.addNote("n1", "x")
	var wg sync.WaitGroup
	rooms := make([]*Room, 8)
	for i := range rooms {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, release, err := th.hub.acquire(context.Background(), "n1")
			if err != nil {
				t.Error(err)
				return
			}
			rooms[i] = r
			release()
		}()
	}
	wg.Wait()
	for _, r := range rooms[1:] {
		if r != rooms[0] {
			t.Fatal("two rooms for one note")
		}
	}
}

func TestReadOnlyUpdatesDropped(t *testing.T) {
	th := newTestHub(t, time.Minute)
	th.addNote("n1", "base")
	th.setLevel("viewer", permission.Read)
	v := th.connect("n1", "viewer", 9)
	w := th.connect("n1", "writer", 10)
	v.typeText("base hacked")
	w.typeText("base ok")
	eventually(t, "writer edit lands", func() bool { txt, _ := th.hub.LiveText("n1"); return txt == "base ok" })
	time.Sleep(50 * time.Millisecond)
	if txt, _ := th.hub.LiveText("n1"); txt != "base ok" {
		t.Fatalf("read-only edit applied: %q", txt)
	}
	if ev := v.appEvents(); len(ev) == 0 || ev[0]["level"] != "read" {
		t.Fatalf("viewer not told it is read-only: %v", ev)
	}
}

func TestForeignClientIDRejected(t *testing.T) {
	th := newTestHub(t, time.Minute)
	th.addNote("n1", "")
	a := th.connect("n1", "alice", 500)
	a.typeText("alice text")
	eventually(t, "alice edit", func() bool { txt, _ := th.hub.LiveText("n1"); return txt == "alice text" })

	// Mallory forges an insert under alice's client ID.
	m := th.connect("n1", "mallory", 600)
	forged, err := m.doc.editAs(500, "alice text, forged")
	if err != nil {
		t.Fatal(err)
	}
	m.send(encodeSyncUpdate(forged))
	time.Sleep(100 * time.Millisecond)
	if txt, _ := th.hub.LiveText("n1"); txt != "alice text" {
		t.Fatalf("forged update applied: %q", txt)
	}
	// Mallory's own ID still works.
	m.typeText("alice text!")
	eventually(t, "mallory own edit", func() bool { txt, _ := th.hub.LiveText("n1"); return txt == "alice text!" })
	th.store.mu.Lock()
	reg := th.store.clients["n1"][600]
	th.store.mu.Unlock()
	if reg.UserID != "mallory" || reg.Source != "human" {
		t.Fatalf("registry %+v", reg)
	}
}

func TestSaveOnCloseAndReload(t *testing.T) {
	th := newTestHub(t, 30*time.Millisecond)
	th.addNote("n1", "")
	a := th.connect("n1", "alice", 1)
	a.typeText("persist me")
	eventually(t, "edit", func() bool { txt, _ := th.hub.LiveText("n1"); return txt == "persist me" })
	_ = a.ws.CloseNow()
	eventually(t, "saved on close", func() bool { return th.store.savedText("n1") == "persist me" })
	if _, open := th.hub.LiveText("n1"); open {
		t.Fatal("room still open after grace")
	}
	b := th.connect("n1", "bob", 2)
	if b.doc.text() != "persist me" {
		t.Fatalf("reload %q", b.doc.text())
	}
}

func TestQuickReconnectKeepsRoom(t *testing.T) {
	th := newTestHub(t, 500*time.Millisecond)
	th.addNote("n1", "")
	r1, release, _ := th.hub.acquire(context.Background(), "n1")
	release()
	r2, release2, _ := th.hub.acquire(context.Background(), "n1")
	defer release2()
	if r1 != r2 {
		t.Fatal("room recreated within grace")
	}
	th.store.mu.Lock()
	saves := th.store.saves["n1"]
	th.store.mu.Unlock()
	if saves != 0 {
		t.Fatalf("saved during grace: %d", saves)
	}
}

func TestPermissionDowngradeSwitchesToReadOnly(t *testing.T) {
	th := newTestHub(t, time.Minute)
	th.addNote("n1", "start")
	b := th.connect("n1", "bob", 2)
	th.setLevel("bob", permission.Comment)
	th.hub.PermissionsChanged("n1")
	eventually(t, "access event", func() bool {
		ev := b.appEvents()
		return len(ev) >= 2 && ev[len(ev)-1]["level"] == "comment"
	})
	b.typeText("start edited")
	time.Sleep(50 * time.Millisecond)
	if txt, _ := th.hub.LiveText("n1"); txt != "start" {
		t.Fatalf("downgraded edit applied: %q", txt)
	}
}

func TestPermissionRemovalClosesConnection(t *testing.T) {
	th := newTestHub(t, time.Minute)
	th.addNote("n1", "")
	b := th.connect("n1", "bob", 2)
	th.setLevel("bob", permission.Deny)
	th.hub.PermissionsChanged("n1")
	select {
	case <-b.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("connection not closed")
	}
}

func TestDeleteAnnouncesAndCloses(t *testing.T) {
	th := newTestHub(t, time.Minute)
	th.addNote("n1", "")
	a := th.connect("n1", "alice", 1)
	th.hub.CloseNote("n1", "deleted")
	select {
	case <-a.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("connection not closed")
	}
	found := false
	for _, ev := range a.appEvents() {
		if ev["type"] == "deleted" {
			found = true
		}
	}
	if !found {
		t.Fatal("no deleted event")
	}
}

func TestServerEditIsAttributed(t *testing.T) {
	th := newTestHub(t, time.Minute)
	th.addNote("n1", "one two")
	a := th.connect("n1", "alice", 1)
	text, err := th.hub.Edit(context.Background(), "n1", Author{UserID: "alice", Name: "ALICE", Source: "ai_assisted"},
		func(v EditView) (string, error) { return "one 2", nil })
	if err != nil || text != "one 2" {
		t.Fatalf("%q %v", text, err)
	}
	eventually(t, "peer sees edit", func() bool { return a.doc.text() == "one 2" })
	var cid uint64
	for _, r := range a.doc.attribution() {
		if r.text == "2" {
			cid = r.clientID
		}
	}
	th.store.mu.Lock()
	reg := th.store.clients["n1"][cid]
	th.store.mu.Unlock()
	if reg.Source != "ai_assisted" || reg.UserID != "alice" {
		t.Fatalf("registry for %d: %+v", cid, reg)
	}
	eventually(t, "update logged", func() bool {
		th.store.mu.Lock()
		defer th.store.mu.Unlock()
		for _, u := range th.store.updates["n1"] {
			if u.Source == "ai_assisted" && u.UserID == "alice" {
				return true
			}
		}
		return false
	})
}

func TestEditOnClosedNoteOpensAndSaves(t *testing.T) {
	th := newTestHub(t, 20*time.Millisecond)
	th.addNote("n1", "a")
	if _, err := th.hub.Edit(context.Background(), "n1", Author{UserID: "bot", Source: "agent"},
		func(v EditView) (string, error) { return v.Text + "b", nil }); err != nil {
		t.Fatal(err)
	}
	eventually(t, "saved", func() bool { return th.store.savedText("n1") == "ab" })
}
