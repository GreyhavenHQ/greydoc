package collab

import "testing"

func TestUpdateClockRanges(t *testing.T) {
	d := docWith(t, "alice text")
	up, _ := d.editAs(1001, "alice 😀 text, more")
	ranges, err := updateClockRanges(up)
	if err != nil {
		t.Fatal(err)
	}
	r, ok := ranges[1001]
	if !ok || r.start != 10 || r.end != 10+uint64(utf16Len(" 😀"))+uint64(utf16Len(", more")) {
		t.Fatalf("ranges %+v", ranges)
	}

	first := d.state()
	all, err := updateClockRanges(first)
	if err != nil || all[1001].start != 0 || all[1001].end != 10 {
		t.Fatalf("full state ranges %+v %v", all, err)
	}

	_ = d.apply(up, nil)
	del, _ := d.editAs(2002, "alice")
	dr, err := updateClockRanges(del)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := dr[2002]; ok {
		t.Fatalf("delete-only update claims structs: %+v", dr)
	}
}

func TestUpdateClockRangesMergedClients(t *testing.T) {
	a := docWith(t, "x")
	b := newCRDT(0)
	_ = b.apply(a.state(), nil)
	u1, _ := a.editAs(7, "xy")
	u2, _ := b.editAs(8, "zx")
	merged, err := mergeUpdates([][]byte{u1, u2})
	if err != nil {
		t.Fatal(err)
	}
	r, err := updateClockRanges(merged)
	if err != nil || r[7].end != 1 || r[8].end != 1 {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestUpdateClockRangesRejectsGarbage(t *testing.T) {
	if _, err := updateClockRanges([]byte{1, 1, 5, 0, 0x7f}); err == nil {
		t.Fatal("garbage parsed")
	}
}
