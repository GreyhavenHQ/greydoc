package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/greyhavenhq/greydoc/internal/config"
)

type groupView struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	OIDCGroup   string `json:"oidc_group"`
	MemberCount int    `json:"member_count"`
	NoteCount   int    `json:"note_count"`
}

func adminEnv(t *testing.T) (*testEnv, *fakeIdP) {
	return newOIDCEnv(t, func(c *config.Config) { c.AdminGroup = "admins" })
}

func TestGroupAdminAccess(t *testing.T) {
	e, idp := adminEnv(t)
	admin := e.login(idp, map[string]any{"sub": "x", "preferred_username": "root", "groups": []string{"admins"}})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	if code, _ := e.do(nil, "GET", "/api/admin/groups", nil); code != 401 {
		t.Fatalf("guest: %d", code)
	}
	if code, _ := e.do(bob, "GET", "/api/admin/groups", nil); code != 403 {
		t.Fatalf("non-admin: %d", code)
	}
	_, body := e.do(admin, "POST", "/api/tokens", map[string]string{"label": "cli"})
	var tok struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal([]byte(body), &tok)
	if code, _ := e.do(nil, "GET", "/api/admin/groups", nil, "Authorization", "Bearer "+tok.Token); code != 403 {
		t.Fatalf("admin token: %d", code)
	}
	if code, b := e.do(admin, "GET", "/api/admin/groups", nil); code != 200 || !strings.Contains(b, `"groups":[]`) {
		t.Fatalf("admin: %d %s", code, b)
	}

	local := newTestEnv(t)
	if code, _ := local.do(nil, "GET", "/api/admin/groups", nil); code != 404 {
		t.Fatalf("local mode: %d", code)
	}
}

func TestGroupAdminLifecycle(t *testing.T) {
	e, idp := adminEnv(t)
	admin := e.login(idp, map[string]any{"sub": "x", "preferred_username": "root", "groups": []string{"admins"}})
	alice := e.login(idp, map[string]any{"sub": "a", "preferred_username": "alice", "groups": []string{"eng"}})
	e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})

	code, body := e.do(admin, "POST", "/api/admin/groups", map[string]string{"name": " Design ", "description": "UX"})
	var design groupView
	_ = json.Unmarshal([]byte(body), &design)
	if code != 201 || design.Name != "Design" || design.OIDCGroup != "" {
		t.Fatalf("create: %d %s", code, body)
	}
	if code, _ := e.do(admin, "POST", "/api/admin/groups", map[string]string{"name": "design"}); code != 409 {
		t.Fatalf("duplicate: %d", code)
	}
	if code, _ := e.do(admin, "POST", "/api/admin/groups", map[string]string{"name": " "}); code != 400 {
		t.Fatalf("empty name: %d", code)
	}
	_, body = e.do(admin, "POST", "/api/admin/groups", map[string]string{"name": "Engineering", "oidc_group": "eng"})
	var eng groupView
	_ = json.Unmarshal([]byte(body), &eng)

	if code, b := e.do(admin, "PUT", "/api/admin/groups/"+design.ID+"/members/alice", nil); code != 200 || !strings.Contains(b, `"username":"alice"`) {
		t.Fatalf("add alice: %d %s", code, b)
	}
	e.do(admin, "PUT", "/api/admin/groups/"+design.ID+"/members/bob", nil)
	if code, _ := e.do(admin, "PUT", "/api/admin/groups/"+design.ID+"/members/nobody", nil); code != 404 {
		t.Fatalf("unknown user: %d", code)
	}
	if code, _ := e.do(admin, "PUT", "/api/admin/groups/"+eng.ID+"/members/bob", nil); code != 400 {
		t.Fatalf("manual member on linked group: %d", code)
	}
	if code, _ := e.do(admin, "PATCH", "/api/admin/groups/"+design.ID, map[string]string{"oidc_group": "eng2"}); code != 400 {
		t.Fatalf("kind change: %d", code)
	}
	if code, b := e.do(admin, "PATCH", "/api/admin/groups/"+design.ID, map[string]string{"name": "Product design"}); code != 200 || !strings.Contains(b, `"description":"UX"`) {
		t.Fatalf("rename: %d %s", code, b)
	}
	_, body = e.do(admin, "GET", "/api/admin/groups/"+eng.ID, nil)
	if !strings.Contains(body, `"username":"alice"`) || strings.Contains(body, `"username":"bob"`) {
		t.Fatalf("linked members: %s", body)
	}
	_, body = e.do(admin, "GET", "/api/admin/groups", nil)
	var list struct{ Groups []groupView }
	_ = json.Unmarshal([]byte(body), &list)
	if len(list.Groups) != 2 || list.Groups[0].Name != "Engineering" || list.Groups[1].MemberCount != 2 {
		t.Fatalf("list: %s", body)
	}

	alias := e.createNote(alice, "# Spec")
	e.do(alice, "PUT", "/api/notes/"+alias+"/permissions/groups/"+design.ID, map[string]string{"level": "read"})
	_, body = e.do(admin, "GET", "/api/admin/groups/"+design.ID, nil)
	if !strings.Contains(body, `"note_count":1`) {
		t.Fatalf("note count: %s", body)
	}
	_, body = e.do(admin, "GET", "/api/admin/groups", nil)
	if !strings.Contains(body, `"members":[{"id"`) {
		t.Fatalf("member preview: %s", body)
	}
	if code, b := e.do(admin, "DELETE", "/api/admin/groups/"+design.ID, nil); code != 200 || !strings.Contains(b, `"notes":1`) {
		t.Fatalf("delete: %d %s", code, b)
	}
	if _, b := e.do(alice, "GET", "/api/notes/"+alias+"/permissions", nil); strings.Contains(b, design.ID) {
		t.Fatalf("grant kept: %s", b)
	}

	_, body = e.do(admin, "GET", "/api/audit?kind=group", nil)
	for _, k := range []string{"group.create", "group.update", "group.member.add", "group.delete"} {
		if !strings.Contains(body, `"kind":"`+k+`"`) {
			t.Fatalf("audit lacks %s: %s", k, body)
		}
	}
	if !strings.Contains(body, `"actor_name":"root"`) {
		t.Fatalf("audit actor: %s", body)
	}
}

func TestRemovingMemberClosesOpenEditor(t *testing.T) {
	e, idp := adminEnv(t)
	admin := e.login(idp, map[string]any{"sub": "x", "preferred_username": "root", "groups": []string{"admins"}})
	owner := e.login(idp, map[string]any{"sub": "o", "preferred_username": "owner"})
	bob := e.login(idp, map[string]any{"sub": "b", "preferred_username": "bob"})
	_, body := e.do(admin, "POST", "/api/admin/groups", map[string]string{"name": "Design"})
	var g groupView
	_ = json.Unmarshal([]byte(body), &g)
	e.do(admin, "PUT", "/api/admin/groups/"+g.ID+"/members/owner", nil)
	e.do(admin, "PUT", "/api/admin/groups/"+g.ID+"/members/bob", nil)
	alias := e.createNote(owner, "secret")
	if code, b := e.do(owner, "PUT", "/api/notes/"+alias+"/permissions/groups/"+g.ID, map[string]string{"level": "write"}); code != 200 {
		t.Fatalf("grant: %d %s", code, b)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, e.wsURL()+"/"+alias, &websocket.DialOptions{HTTPHeader: cookieHeader(e, bob)})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if code, b := e.do(admin, "DELETE", "/api/admin/groups/"+g.ID+"/members/bob", nil); code != 200 {
		t.Fatalf("remove: %d %s", code, b)
	}
	for {
		if _, _, err := ws.Read(ctx); err != nil {
			if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
				t.Fatalf("closed with %v", err)
			}
			return
		}
	}
}

func TestShareWithGroups(t *testing.T) {
	e, idp := adminEnv(t)
	admin := e.login(idp, map[string]any{"sub": "x", "preferred_username": "root", "groups": []string{"admins"}})
	alice := e.login(idp, map[string]any{"sub": "a", "preferred_username": "alice", "groups": []string{"eng"}})
	e.login(idp, map[string]any{"sub": "c", "preferred_username": "carol", "groups": []string{"eng"}})
	_, body := e.do(admin, "POST", "/api/admin/groups", map[string]string{"name": "Design"})
	var design groupView
	_ = json.Unmarshal([]byte(body), &design)
	_, body = e.do(admin, "POST", "/api/admin/groups", map[string]string{"name": "Engineering", "oidc_group": "eng"})
	var eng groupView
	_ = json.Unmarshal([]byte(body), &eng)
	alias := e.createNote(alice, "# Spec")

	// The picker lists only the caller's groups. Admins see all.
	if _, b := e.do(alice, "GET", "/api/users?q=", nil); !strings.Contains(b, `{"id":"`+eng.ID+`","name":"Engineering"}`) || strings.Contains(b, "Design") {
		t.Fatalf("alice picker: %s", b)
	}
	if _, b := e.do(alice, "GET", "/api/users?q=des", nil); strings.Contains(b, "Engineering") {
		t.Fatalf("filter: %s", b)
	}
	if _, b := e.do(admin, "GET", "/api/users?q=", nil); !strings.Contains(b, "Design") || !strings.Contains(b, "Engineering") {
		t.Fatalf("admin picker: %s", b)
	}

	grant := func(group, level string) int {
		code, _ := e.do(alice, "PUT", "/api/notes/"+alias+"/permissions/groups/"+group, map[string]string{"level": level})
		return code
	}
	if code := grant(design.ID, "write"); code != 403 {
		t.Fatalf("group alice is not in: %d", code)
	}
	if code := grant("nope", "write"); code != 404 {
		t.Fatalf("unknown group: %d", code)
	}
	if code := grant(eng.ID, "write"); code != 200 {
		t.Fatalf("own group: %d", code)
	}
	// Carol reads through the group, and the share search says so.
	if _, b := e.do(alice, "GET", "/api/users?q=carol&note="+alias, nil); !strings.Contains(b, `"username":"carol","display_name":"carol","can_read":true`) {
		t.Fatalf("can_read through a group: %s", b)
	}
	// Members filter the document list by group. Others may not.
	e.createNote(alice, "# Unshared")
	if code, b := e.do(alice, "GET", "/api/notes?scope=all&group="+eng.ID, nil); code != 200 || !strings.Contains(b, `"alias":"`+alias+`"`) ||
		strings.Contains(b, "Unshared") || !strings.Contains(b, `"group":{"id":"`+eng.ID+`","name":"Engineering"}`) {
		t.Fatalf("group filter: %d %s", code, b)
	}
	if code, _ := e.do(alice, "GET", "/api/notes?group="+design.ID, nil); code != 403 {
		t.Fatalf("filter by a group alice is not in: %d", code)
	}
	if code, _ := e.do(alice, "GET", "/api/notes?group=nope", nil); code != 404 {
		t.Fatalf("filter by unknown group: %d", code)
	}
	if code, b := e.do(alice, "DELETE", "/api/notes/"+alias+"/permissions/groups/stale", nil); code != 200 {
		t.Fatalf("removing a stale grant: %d %s", code, b)
	}

	adminNote := e.createNote(admin, "# Admin")
	if code, _ := e.do(admin, "PUT", "/api/notes/"+adminNote+"/permissions/groups/"+design.ID, map[string]string{"level": "read"}); code != 200 {
		t.Fatalf("admin grants any group: %d", code)
	}

	// Imports name groups.
	code, b := e.do(alice, "POST", "/api/notes", map[string]any{"content": "# Imp", "permissions": map[string]any{"groups": map[string]string{"engineering": "comment"}}})
	if code != 201 {
		t.Fatalf("import with group: %d %s", code, b)
	}
	var created struct{ Alias string }
	_ = json.Unmarshal([]byte(b), &created)
	if _, b := e.do(alice, "GET", "/api/notes/"+created.Alias+"/permissions", nil); !strings.Contains(b, `"group":"`+eng.ID+`","name":"Engineering","level":"comment"`) {
		t.Fatalf("imported grant: %s", b)
	}
	if code, _ := e.do(alice, "POST", "/api/notes", map[string]any{"content": "x", "permissions": map[string]any{"groups": map[string]string{"Design": "read"}}}); code != 400 {
		t.Fatalf("import with a group alice is not in: %d", code)
	}
	if code, _ := e.do(alice, "POST", "/api/notes", map[string]any{"content": "x", "permissions": map[string]any{"groups": map[string]string{"ghosts": "read"}}}); code != 400 {
		t.Fatalf("import with unknown group: %d", code)
	}
}

func TestBundleKeepsGroupGrantsByName(t *testing.T) {
	ctx := context.Background()
	src := newTestEnv(t)
	if _, err := src.srv.Store().CreateGroup(ctx, "Design", "", "", nil); err != nil {
		t.Fatal(err)
	}
	code, body := src.do(nil, "POST", "/api/notes", map[string]any{"content": "# Trip\n", "alias": "trip",
		"permissions": map[string]any{"groups": map[string]string{"Design": "write"}}})
	if code != 201 {
		t.Fatalf("%d %s", code, body)
	}
	_, raw := src.get("/api/notes/trip/export.zip")

	dst := newTestEnv(t)
	g, _ := dst.srv.Store().CreateGroup(ctx, "design", "", "", nil)
	if code, body := importBundle(t, dst, "trip.zip", []byte(raw)); code != 201 {
		t.Fatalf("import: %d %s", code, body)
	}
	if _, b := dst.get("/api/notes/trip/permissions"); !strings.Contains(b, `"group":"`+g.ID+`"`) {
		t.Fatalf("grant not mapped: %s", b)
	}

	other := newTestEnv(t)
	if code, body := importBundle(t, other, "trip.zip", []byte(raw)); code != 201 {
		t.Fatalf("import without the group: %d %s", code, body)
	}
}
