package history

import "testing"

func TestUnifiedDiff(t *testing.T) {
	a := "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n"
	b := "1\n2\n3\nfour\n5\n6\n7\n8\n9\n10\neleven\n"
	patch, added, removed := UnifiedDiff(a, b)
	want := "@@ -1,10 +1,11 @@\n 1\n 2\n 3\n-4\n+four\n 5\n 6\n 7\n 8\n 9\n 10\n+eleven\n"
	if patch != want || added != 2 || removed != 1 {
		t.Fatalf("got\n%s\nadded %d removed %d", patch, added, removed)
	}
	far := "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n"
	patch, _, _ = UnifiedDiff(far, "one\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\ntwelve\n")
	if patch != "@@ -1,4 +1,4 @@\n-1\n+one\n 2\n 3\n 4\n@@ -9,4 +9,4 @@\n 9\n 10\n 11\n-12\n+twelve\n" {
		t.Fatalf("two hunks:\n%s", patch)
	}
	if p, a2, r2 := UnifiedDiff("x", "x"); p != "" || a2 != 0 || r2 != 0 {
		t.Fatalf("identical: %q", p)
	}
	if p, _, _ := UnifiedDiff("", "new"); p != "@@ -0,0 +1,1 @@\n+new\n\\ No newline at end of file\n" {
		t.Fatalf("from empty: %q", p)
	}
}
