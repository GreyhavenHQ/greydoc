package history

import (
	"fmt"
	"strings"

	"github.com/sergi/go-diff/diffmatchpatch"
)

type lineOp struct {
	op   diffmatchpatch.Operation
	line string
}

func lineOps(a, b string) []lineOp {
	dmp := diffmatchpatch.New()
	ca, cb, lines := dmp.DiffLinesToChars(a, b)
	diffs := dmp.DiffCharsToLines(dmp.DiffMain(ca, cb, false), lines)
	var ops []lineOp
	for _, d := range diffs {
		text := d.Text
		for text != "" {
			i := strings.IndexByte(text, '\n')
			var line string
			if i < 0 {
				line, text = text, ""
			} else {
				line, text = text[:i+1], text[i+1:]
			}
			ops = append(ops, lineOp{d.Type, line})
		}
	}
	return ops
}

// UnifiedDiff returns a unified diff with 3 lines of context and the added and removed line counts.
func UnifiedDiff(a, b string) (string, int, int) {
	ops := lineOps(a, b)
	added, removed := 0, 0
	for _, o := range ops {
		switch o.op {
		case diffmatchpatch.DiffInsert:
			added++
		case diffmatchpatch.DiffDelete:
			removed++
		}
	}
	const ctx = 3
	var out strings.Builder
	n := len(ops)
	i := 0
	aLine, bLine := 1, 1
	for i < n {
		if ops[i].op == diffmatchpatch.DiffEqual {
			aLine++
			bLine++
			i++
			continue
		}
		start := max(i-ctx, 0)
		end := i
		for end < n {
			if ops[end].op != diffmatchpatch.DiffEqual {
				end++
				continue
			}
			run := end
			for run < n && ops[run].op == diffmatchpatch.DiffEqual {
				run++
			}
			if run == n || run-end > 2*ctx {
				end = min(end+ctx, n)
				break
			}
			end = run
		}
		aStart, bStart := aLine-(i-start), bLine-(i-start)
		var aCount, bCount int
		var body strings.Builder
		for _, o := range ops[start:end] {
			line := o.line
			if !strings.HasSuffix(line, "\n") {
				line += "\n\\ No newline at end of file\n"
			}
			switch o.op {
			case diffmatchpatch.DiffEqual:
				body.WriteString(" " + line)
				aCount++
				bCount++
			case diffmatchpatch.DiffDelete:
				body.WriteString("-" + line)
				aCount++
			case diffmatchpatch.DiffInsert:
				body.WriteString("+" + line)
				bCount++
			}
		}
		if aCount == 0 {
			aStart--
		}
		if bCount == 0 {
			bStart--
		}
		fmt.Fprintf(&out, "@@ -%d,%d +%d,%d @@\n%s", aStart, aCount, bStart, bCount, body.String())
		for _, o := range ops[i:end] {
			if o.op != diffmatchpatch.DiffInsert {
				aLine++
			}
			if o.op != diffmatchpatch.DiffDelete {
				bLine++
			}
		}
		i = end
	}
	return out.String(), added, removed
}
