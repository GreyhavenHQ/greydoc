package collab

import "testing"

func docWith(t *testing.T, text string) *crdtDoc {
	t.Helper()
	d := newCRDT(0)
	if text == "" {
		return d
	}
	up, err := d.editAs(1001, text)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.apply(up, nil); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestEditAsUsesItsOwnClientID(t *testing.T) {
	d := docWith(t, "hello world")
	up, err := d.editAs(4242, "hello brave world")
	if err != nil {
		t.Fatal(err)
	}
	sv, err := updateStateVector(up)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := sv[4242]; !ok || len(sv) != 1 {
		t.Fatalf("update clients %v", sv)
	}
	if err := d.apply(up, nil); err != nil {
		t.Fatal(err)
	}
	if d.text() != "hello brave world" {
		t.Fatalf("%q", d.text())
	}
}

func TestEditAsIsMinimal(t *testing.T) {
	d := docWith(t, "line one\nline two\nline three\n")
	up, _ := d.editAs(5, "line one\nline 2\nline three\n")
	_ = d.apply(up, nil)
	runs := d.attribution()
	var by5 string
	for _, r := range runs {
		if r.clientID == 5 {
			by5 += r.text
		}
	}
	if by5 != "2" {
		t.Fatalf("client 5 wrote %q, want only the changed text", by5)
	}
}

func TestServerEditMergesWithConcurrentTyping(t *testing.T) {
	server := docWith(t, "abc\n")
	browser := newCRDT(77)
	_ = browser.apply(server.state(), nil)

	typed, _ := browser.editAs(77, "abc\nxyz")
	edit, _ := server.editAs(88, "ABC\n")
	_ = server.apply(edit, nil)
	_ = server.apply(typed, nil)
	_ = browser.apply(typed, nil)
	_ = browser.apply(edit, nil)
	if server.text() != "ABC\nxyz" || browser.text() != server.text() {
		t.Fatalf("server %q browser %q", server.text(), browser.text())
	}
}

func TestRelativePositionFollowsText(t *testing.T) {
	d := docWith(t, "hello world")
	rp, err := d.relPos(6, 0)
	if err != nil {
		t.Fatal(err)
	}
	up, _ := d.editAs(9, "oh, hello world")
	_ = d.apply(up, nil)
	idx, ok := d.resolveRelPos(rp)
	if !ok || idx != 10 {
		t.Fatalf("idx %d ok %v", idx, ok)
	}
}

func TestUTF16Offsets(t *testing.T) {
	s := "a😀é"
	if utf16Len(s) != 4 {
		t.Fatal(utf16Len(s))
	}
	if byteOffset(s, 3) != 5 || utf16Offset(s, 5) != 3 {
		t.Fatalf("%d %d", byteOffset(s, 3), utf16Offset(s, 5))
	}
}
