package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func (e *testEnv) createFolder(c *http.Client, name, parent string) string {
	e.t.Helper()
	code, body := e.do(c, "POST", "/api/folders", map[string]string{"name": name, "parent": parent})
	if code != 201 {
		e.t.Fatalf("create folder: %d %s", code, body)
	}
	var out struct {
		Folder struct{ ID string } `json:"folder"`
	}
	_ = json.Unmarshal([]byte(body), &out)
	return out.Folder.ID
}

func (e *testEnv) move(c *http.Client, notes []string, folders []string, to string, dryRun bool) (int, string) {
	e.t.Helper()
	return e.do(c, "POST", "/api/move", map[string]any{"notes": notes, "folders": folders, "to": to, "dry_run": dryRun})
}

func TestFolderSharingAndMoves(t *testing.T) {
	e, idp := newOIDCEnv(t)
	alice := e.login(idp, map[string]any{"sub": "a", "preferred_username": "alice"})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	carol := e.login(idp, map[string]any{"sub": "c", "preferred_username": "carol"})
	project := e.createFolder(alice, "Project X", "")
	specs := e.createFolder(alice, "Specs", project)
	plan := e.createNote(alice, "# Plan")
	deep := e.createNote(alice, "# Deep")

	if code, b := e.move(alice, []string{plan}, nil, project, false); code != 200 {
		t.Fatalf("move plan: %d %s", code, b)
	}
	if code, b := e.move(alice, []string{deep}, nil, specs, false); code != 200 {
		t.Fatalf("move deep: %d %s", code, b)
	}
	if code, _ := e.do(bob, "GET", "/api/notes/"+deep, nil); code != 403 {
		t.Fatalf("bob before share: %d", code)
	}
	if code, _ := e.do(bob, "GET", "/api/folders/"+project, nil); code != 404 {
		t.Fatalf("bob sees a private folder: %d", code)
	}

	if code, b := e.do(alice, "PUT", "/api/folders/"+project+"/permissions/users/bob", map[string]string{"level": "read"}); code != 200 {
		t.Fatalf("share folder: %d %s", code, b)
	}
	code, body := e.do(bob, "GET", "/api/notes/"+deep, nil)
	if code != 200 || !strings.Contains(body, `"level":"read"`) {
		t.Fatalf("bob through grandparent: %d %s", code, body)
	}
	if _, body := e.do(bob, "GET", "/api/folders?scope=shared", nil); !strings.Contains(body, "Project X") {
		t.Fatalf("shared folders: %s", body)
	}
	if _, body := e.do(bob, "GET", "/api/notes?scope=shared", nil); strings.Contains(body, plan) {
		t.Fatalf("a note shared only through a folder is listed in shared: %s", body)
	}
	if _, body := e.do(bob, "GET", "/api/notes?scope=all", nil); !strings.Contains(body, deep) || !strings.Contains(body, `"folder_name":"Specs"`) {
		t.Fatalf("all: %s", body)
	}
	_, body = e.do(bob, "GET", "/api/folders/"+specs, nil)
	if !strings.Contains(body, `"path":[{"id":"`+project+`","name":"Project X"}]`) {
		t.Fatalf("path: %s", body)
	}
	if code, _ := e.do(bob, "PATCH", "/api/folders/"+project, map[string]string{"name": "Mine"}); code != 403 {
		t.Fatalf("reader renamed: %d", code)
	}

	// A grant on the document adds to the folder.
	e.do(alice, "PUT", "/api/notes/"+plan+"/permissions/users/carol", map[string]string{"level": "write"})
	_, body = e.do(alice, "GET", "/api/notes/"+plan+"/permissions", nil)
	if !strings.Contains(body, `"inherited":[{"folder_id":"`+project) {
		t.Fatalf("inherited grants: %s", body)
	}
	code, body = e.move(alice, []string{plan}, nil, "", true)
	if code != 200 || !strings.Contains(body, `"who":"bob"`) || !strings.Contains(body, `"after":"deny"`) || strings.Contains(body, "carol") {
		t.Fatalf("dry run: %d %s", code, body)
	}
	if code, _ := e.do(bob, "GET", "/api/notes/"+plan, nil); code != 200 {
		t.Fatal("dry run moved the note")
	}
	e.move(alice, []string{plan}, nil, "", false)
	if code, _ := e.do(bob, "GET", "/api/notes/"+plan, nil); code != 403 {
		t.Fatalf("bob after move out: %d", code)
	}
	if _, body := e.do(carol, "GET", "/api/notes/"+plan, nil); !strings.Contains(body, `"level":"write"`) {
		t.Fatalf("carol lost her own grant: %s", body)
	}
	_, body = e.do(alice, "GET", "/api/notes/"+plan+"/timeline", nil)
	if !strings.Contains(body, "note.move") {
		t.Fatalf("no move on the timeline: %s", body)
	}

	// Editors of a folder file their own documents there. The folder owner gets edit on them.
	e.do(alice, "PUT", "/api/folders/"+project+"/permissions/users/bob", map[string]string{"level": "write"})
	code, body = e.do(bob, "POST", "/api/notes", map[string]string{"content": "# Bob's", "folder": project})
	if code != 201 {
		t.Fatalf("bob creates in folder: %d %s", code, body)
	}
	var bn struct{ Alias string }
	_ = json.Unmarshal([]byte(body), &bn)
	if _, body := e.do(alice, "GET", "/api/notes/"+bn.Alias, nil); !strings.Contains(body, `"level":"write"`) {
		t.Fatalf("folder owner on bob's note: %s", body)
	}
	if _, body := e.do(bob, "GET", "/api/notes/"+bn.Alias+"/permissions", nil); strings.Contains(body, "_signed_in") {
		t.Fatalf("note in folder got default grants: %s", body)
	}
	bobs := e.createFolder(bob, "Bob's own", "")
	if code, _ := e.move(bob, []string{deep}, nil, bobs, false); code != 403 {
		t.Fatalf("bob moved alice's note: %d", code)
	}
	carols := e.createNote(carol, "carol's")
	if code, _ := e.move(carol, []string{carols}, nil, project, false); code != 404 {
		t.Fatalf("carol moved into a folder she cannot see: %d", code)
	}
	e.do(alice, "PUT", "/api/folders/"+project+"/permissions/users/carol", map[string]string{"level": "read"})
	if code, _ := e.move(carol, []string{carols}, nil, project, false); code != 403 {
		t.Fatalf("carol moved into a folder she cannot edit: %d", code)
	}
	if code, _ := e.move(alice, nil, []string{project}, specs, false); code != 400 {
		t.Fatalf("cycle: %d", code)
	}

	// Trash takes alice's items. Bob's note goes to his top level.
	if code, b := e.do(alice, "DELETE", "/api/folders/"+project, nil); code != 200 || !strings.Contains(b, `"moved_out":1`) {
		t.Fatalf("trash folder: %d %s", code, b)
	}
	if code, _ := e.do(alice, "GET", "/api/notes/"+deep, nil); code != 410 {
		t.Fatalf("deep note after trash: %d", code)
	}
	if _, body := e.do(bob, "GET", "/api/notes?scope=mine&folder=root", nil); !strings.Contains(body, bn.Alias) {
		t.Fatalf("bob's note not at his top level: %s", body)
	}
	if _, body := e.do(alice, "GET", "/api/trash", nil); !strings.Contains(body, "Project X") {
		t.Fatalf("trash: %s", body)
	}
	if code, _ := e.do(bob, "POST", "/api/folders/"+project+"/restore", nil); code != 404 {
		t.Fatalf("bob restored: %d", code)
	}
	if code, b := e.do(alice, "POST", "/api/folders/"+project+"/restore", nil); code != 200 {
		t.Fatalf("restore: %d %s", code, b)
	}
	if code, _ := e.do(alice, "GET", "/api/notes/"+deep, nil); code != 200 {
		t.Fatalf("deep note after restore: %d", code)
	}
	if _, body := e.do(alice, "GET", "/api/notes?folder="+specs, nil); !strings.Contains(body, deep) {
		t.Fatalf("deep note left its folder: %s", body)
	}
}

func TestFolderGrantRemovalClosesEditor(t *testing.T) {
	e, idp := newOIDCEnv(t)
	alice := e.login(idp, map[string]any{"sub": "a", "preferred_username": "alice"})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	folder := e.createFolder(alice, "Shared", "")
	alias := e.createNote(alice, "text")
	e.move(alice, []string{alias}, nil, folder, false)
	e.do(alice, "PUT", "/api/folders/"+folder+"/permissions/users/bob", map[string]string{"level": "write"})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, e.wsURL()+"/"+alias, &websocket.DialOptions{HTTPHeader: cookieHeader(e, bob)})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	done := make(chan websocket.StatusCode, 1)
	go func() {
		for {
			if _, _, err := ws.Read(ctx); err != nil {
				done <- websocket.CloseStatus(err)
				return
			}
		}
	}()
	time.Sleep(100 * time.Millisecond)
	e.do(alice, "DELETE", "/api/folders/"+folder+"/permissions/users/bob", nil)
	select {
	case code := <-done:
		if code != websocket.StatusPolicyViolation {
			t.Fatalf("close code %d", code)
		}
	case <-time.After(time.Second):
		t.Fatal("editor still open one second after the folder grant was removed")
	}
}

func TestMCPFolders(t *testing.T) {
	e, idp := newOIDCEnv(t)
	alice := e.login(idp, map[string]any{"sub": "a", "preferred_username": "alice"})
	folder := e.createFolder(alice, "Agents", "")
	_, body := e.do(alice, "POST", "/api/tokens", map[string]string{"label": "laptop"})
	var tok struct{ Token string }
	_ = json.Unmarshal([]byte(body), &tok)
	s := e.mcp(tok.Token)
	if out, isErr := call(t, s, "list_folders", nil); isErr || !strings.Contains(out, "Agents") {
		t.Fatalf("list_folders: %s", out)
	}
	out, isErr := call(t, s, "create_note", map[string]any{"content": "# From agent", "folder": folder, "agent_policy": "edit"})
	if isErr {
		t.Fatalf("create in folder: %s", out)
	}
	var n struct{ Alias string }
	_ = json.Unmarshal([]byte(out), &n)
	if out, _ := call(t, s, "list_notes", map[string]any{"folder": folder}); !strings.Contains(out, n.Alias) {
		t.Fatalf("list in folder: %s", out)
	}
	if out, isErr := call(t, s, "move_note", map[string]any{"note": n.Alias}); isErr {
		t.Fatalf("move out: %s", out)
	}
	if out, _ := call(t, s, "list_notes", map[string]any{"folder": "root", "scope": "mine"}); !strings.Contains(out, n.Alias) {
		t.Fatalf("not at top level: %s", out)
	}
	other := e.createNote(alice, "suggest only")
	if out, isErr := call(t, s, "move_note", map[string]any{"note": other, "folder": folder}); !isErr {
		t.Fatalf("moved a note without the edit policy: %s", out)
	}
}

func TestNoteNamesItsFolderOnlyToReaders(t *testing.T) {
	e, idp := newOIDCEnv(t)
	alice := e.login(idp, map[string]any{"sub": "a", "preferred_username": "alice"})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	carol := e.login(idp, map[string]any{"sub": "c", "preferred_username": "carol"})
	folder := e.createFolder(alice, "Private plans", "")
	alias := e.createNote(alice, "# Plan")
	e.move(alice, []string{alias}, nil, folder, false)
	e.do(alice, "PUT", "/api/folders/"+folder+"/permissions/users/bob", map[string]string{"level": "read"})
	e.do(alice, "PUT", "/api/notes/"+alias+"/permissions/users/carol", map[string]string{"level": "read"})
	if _, body := e.do(bob, "GET", "/api/notes/"+alias, nil); !strings.Contains(body, `"folder":{"id":"`+folder+`","name":"Private plans"}`) {
		t.Fatalf("reader of the folder: %s", body)
	}
	if _, body := e.do(carol, "GET", "/api/notes/"+alias, nil); strings.Contains(body, "Private plans") || strings.Contains(body, `"folder":`) {
		t.Fatalf("carol learned the folder: %s", body)
	}
}
