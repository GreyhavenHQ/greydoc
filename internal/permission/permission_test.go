package permission

import "testing"

// Ported from HedgeDoc backend/src/permissions/test/determine-permission.fixture.ts.
var hedgedocCases = []struct {
	name                                      string
	isOwner, isRegistered                     bool
	maxGuest, user, everyone, loggedIn, group Level
	want                                      Level
}{
	{"owner always has full rights", true, true, Full, Deny, Deny, Deny, Deny, Full},
	{"owner always has full rights (even as a guest)", true, false, Full, Deny, Deny, Deny, Deny, Full},
	{"access denied if no permission is present", false, true, Full, Deny, Deny, Deny, Deny, Deny},
	{"access denied if no permission is present (even as a guest)", false, false, Full, Deny, Deny, Deny, Deny, Deny},
	{"if user has explicit READ permission, logged-in user can READ", false, true, Full, Read, Deny, Deny, Deny, Read},
	{"if user has explicit WRITE permission, logged-in user can WRITE", false, true, Full, Write, Deny, Deny, Deny, Write},
	{"if everyone has READ permission, logged-in user can READ", false, true, Full, Deny, Read, Deny, Deny, Read},
	{"if everyone has READ permission, guest can READ", false, false, Full, Deny, Read, Deny, Deny, Read},
	{"if everyone has WRITE permission, logged-in user can WRITE", false, true, Full, Deny, Write, Deny, Deny, Write},
	{"if everyone has WRITE permission, guest can WRITE", false, false, Full, Deny, Write, Deny, Deny, Write},
	{"if everyone has READ permission, logged-in user can READ (max guest level READ)", false, true, Read, Deny, Read, Deny, Deny, Read},
	{"if everyone has READ permission, guest can READ (max guest level READ)", false, false, Read, Deny, Read, Deny, Deny, Read},
	{"if everyone has WRITE permission, logged-in user can WRITE (max guest level READ)", false, true, Read, Deny, Write, Deny, Deny, Write},
	{"if everyone has WRITE permission, guest can READ (max guest level READ)", false, false, Read, Deny, Write, Deny, Deny, Read},
	{"if logged-in users have READ permission, logged-in user can READ", false, true, Full, Deny, Deny, Read, Deny, Read},
	{"if logged-in users have READ permission, guests are denied", false, false, Full, Deny, Deny, Read, Deny, Deny},
	{"if logged-in users have WRITE permission, logged-in user can WRITE", false, true, Full, Deny, Deny, Write, Deny, Write},
	{"if logged-in users have WRITE permission, guests are denied", false, false, Full, Deny, Deny, Write, Deny, Deny},
	{"if user is in group with READ permission, logged-in user can READ", false, true, Full, Deny, Deny, Deny, Read, Read},
	{"if user is in group with WRITE permission, logged-in user can WRITE", false, true, Full, Deny, Deny, Deny, Write, Write},
	{"highest permission in groups wins (everyone has DENY, logged-in user have READ, group has WRITE -> user can WRITE)", false, true, Full, Deny, Deny, Read, Write, Write},
	{"highest permission in groups wins (everyone has WRITE, logged-in user have READ, group has DENY -> user can WRITE)", false, true, Full, Deny, Write, Read, Deny, Write},
}

func TestDetermineHedgeDocFixture(t *testing.T) {
	for _, c := range hedgedocCases {
		t.Run(c.name, func(t *testing.T) {
			got := Determine(Input{
				IsOwner: c.isOwner, IsRegistered: c.isRegistered, MaxGuest: c.maxGuest,
				User: c.user, Everyone: c.everyone, LoggedIn: c.loggedIn, Group: c.group,
			})
			if got != c.want {
				t.Fatalf("got %s, want %s", got, c.want)
			}
		})
	}
}

func TestDetermineCommentLevel(t *testing.T) {
	cases := []struct {
		name string
		in   Input
		want Level
	}{
		{"user grant comment gives comment", Input{IsRegistered: true, MaxGuest: Write, User: Comment}, Comment},
		{"group comment and logged-in read gives comment", Input{IsRegistered: true, MaxGuest: Write, LoggedIn: Read, Group: Comment}, Comment},
		{"guest capped at read cannot comment", Input{MaxGuest: Read, Everyone: Comment}, Read},
		{"guest with max comment can comment", Input{MaxGuest: Comment, Everyone: Write}, Comment},
		{"grants never reach full", Input{IsRegistered: true, MaxGuest: Full, User: Full}, Write},
		{"local mode is full", Input{Local: true}, Full},
		{"share link gives read to a guest", Input{ShareLink: true}, Read},
		{"share link does not lower a writer", Input{IsRegistered: true, MaxGuest: Write, User: Write, ShareLink: true}, Write},
		{"guest with guest max deny gets nothing from everyone", Input{MaxGuest: Deny, Everyone: Write}, Deny},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Determine(c.in); got != c.want {
				t.Fatalf("got %s, want %s", got, c.want)
			}
		})
	}
}

func TestAgentLevel(t *testing.T) {
	levels := []Level{Deny, Read, Comment, Write, Full}
	want := map[Policy][]Level{
		PolicyNone:    {Deny, Deny, Deny, Deny, Deny},
		PolicyRead:    {Deny, Read, Read, Read, Read},
		PolicySuggest: {Deny, Read, Comment, Comment, Comment},
		PolicyEdit:    {Deny, Read, Comment, Write, Write},
	}
	for policy, row := range want {
		for i, user := range levels {
			if got := AgentLevel(user, policy); got != row[i] {
				t.Errorf("AgentLevel(%s, %s) = %s, want %s", user, policy, got, row[i])
			}
		}
	}
}

func TestParseLevel(t *testing.T) {
	for _, l := range []Level{Deny, Read, Comment, Write, Full} {
		got, ok := ParseLevel(l.String())
		if !ok || got != l {
			t.Fatalf("round trip %s: %s %v", l, got, ok)
		}
	}
	if _, ok := ParseLevel("admin"); ok {
		t.Fatal("unknown level parsed")
	}
}
