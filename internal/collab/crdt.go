package collab

import (
	"errors"

	"github.com/Deln0r/ygo"
	"github.com/sergi/go-diff/diffmatchpatch"
)

// This file is the only importer of ygo. Keep the surface narrow so the CRDT library can be replaced.

// textName is the Y.Text the editor binds to.
const textName = "content"

type crdtDoc struct {
	d *ygo.Doc
}

func newCRDT(clientID uint64) *crdtDoc {
	return &crdtDoc{d: ygo.NewDocWithOptions(ygo.Options{ClientID: clientID})}
}

func (c *crdtDoc) apply(update []byte, origin any) error {
	return ygo.ApplyUpdateWithOrigin(c.d, update, origin)
}

// onUpdate runs fn after each committed transaction with the document lock held.
func (c *crdtDoc) onUpdate(fn func(update []byte, origin any)) func() {
	return c.d.OnUpdate(func(update []byte, origin any) { fn(update, origin) })
}

func (c *crdtDoc) stateVector() []byte { return ygo.EncodeStateVector(c.d) }

func (c *crdtDoc) svMap() map[uint64]uint64 {
	sv, _ := decodeStateVector(c.stateVector())
	return sv
}

func (c *crdtDoc) diff(sv []byte) ([]byte, error) { return ygo.EncodeDiff(c.d, sv) }

func (c *crdtDoc) state() []byte { return ygo.EncodeStateAsUpdate(c.d) }

func (c *crdtDoc) text() string {
	t := ygo.NewText(c.d, textName)
	txn := c.d.ReadTxn()
	defer txn.Close()
	return t.String()
}

func validUpdate(update []byte) error { return ygo.ValidateUpdate(update) }

// updateStateVector returns, per client, the clock reached by the items in update.
func updateStateVector(update []byte) (map[uint64]uint64, error) {
	b, err := ygo.EncodeStateVectorFromUpdate(update)
	if err != nil {
		return nil, err
	}
	return decodeStateVector(b)
}

func mergeUpdates(updates [][]byte) ([]byte, error) { return ygo.MergeUpdates(updates) }

// editAs returns an update that turns the text into newText with a minimal diff, authored by clientID.
func (c *crdtDoc) editAs(clientID uint64, newText string) ([]byte, error) {
	up, _, _, err := editFrom(c.state(), clientID, func(*crdtDoc) (string, error) { return newText, nil })
	return up, err
}

// editFrom replays base into a scratch document, lets fn compute the new text from it, and returns the
// minimal update authored by clientID. The update is relative to base, so applying it to a document
// that moved on since base merges with the newer edits instead of reverting them.
func editFrom(base []byte, clientID uint64, fn func(view *crdtDoc) (string, error)) (update []byte, oldText, newText string, err error) {
	tmp := &crdtDoc{d: ygo.NewDocWithOptions(ygo.Options{ClientID: clientID})}
	if len(base) > 0 {
		if err := ygo.ApplyUpdate(tmp.d, base); err != nil {
			return nil, "", "", err
		}
	}
	baseSV := tmp.stateVector()
	oldText = tmp.text()
	if newText, err = fn(tmp); err != nil {
		return nil, oldText, oldText, err
	}
	if newText == oldText {
		return nil, oldText, newText, nil
	}
	t := ygo.NewText(tmp.d, textName)
	dmp := diffmatchpatch.New()
	diffs := dmp.DiffCleanupSemantic(dmp.DiffMain(oldText, newText, false))
	txn := tmp.d.WriteTxn()
	var pos uint64
	for _, d := range diffs {
		n := uint64(utf16Len(d.Text))
		switch d.Type {
		case diffmatchpatch.DiffEqual:
			pos += n
		case diffmatchpatch.DiffDelete:
			err = t.Delete(txn, pos, n)
		case diffmatchpatch.DiffInsert:
			err = t.Insert(txn, pos, d.Text)
			pos += n
		}
		if err != nil {
			txn.Commit()
			return nil, oldText, newText, err
		}
	}
	txn.Commit()
	update, err = ygo.EncodeDiff(tmp.d, baseSV)
	return update, oldText, newText, err
}

// replaceFrom is editFrom for one exact range: fn returns byte offsets in the text and the replacement.
// The whole replacement is new content from clientID, even where it repeats the old text.
func replaceFrom(base []byte, clientID uint64, fn func(view *crdtDoc) (start, end int, repl string, err error)) ([]byte, error) {
	tmp := &crdtDoc{d: ygo.NewDocWithOptions(ygo.Options{ClientID: clientID})}
	if len(base) > 0 {
		if err := ygo.ApplyUpdate(tmp.d, base); err != nil {
			return nil, err
		}
	}
	baseSV := tmp.stateVector()
	old := tmp.text()
	start, end, repl, err := fn(tmp)
	if err != nil {
		return nil, err
	}
	if start < 0 || end < start || end > len(old) {
		return nil, errors.New("range out of bounds")
	}
	if old[start:end] == repl {
		return nil, nil
	}
	t := ygo.NewText(tmp.d, textName)
	a := uint64(utf16Offset(old, start))
	txn := tmp.d.WriteTxn()
	if n := uint64(utf16Len(old[start:end])); n > 0 {
		err = t.Delete(txn, a, n)
	}
	if err == nil && repl != "" {
		err = t.Insert(txn, a, repl)
	}
	txn.Commit()
	if err != nil {
		return nil, err
	}
	return ygo.EncodeDiff(tmp.d, baseSV)
}

// relPos encodes a Yjs relative position at a UTF-16 index, byte-compatible with Y.encodeRelativePosition.
func (c *crdtDoc) relPos(index int, assoc int64) ([]byte, error) {
	t := ygo.NewText(c.d, textName)
	txn := c.d.ReadTxn()
	rp, err := ygo.CreateRelativePositionFromTypeIndex(t, uint64(index), assoc)
	txn.Close()
	if err != nil {
		return nil, err
	}
	return ygo.EncodeRelativePosition(rp)
}

// resolveRelPos returns the current UTF-16 index of an encoded relative position.
func (c *crdtDoc) resolveRelPos(enc []byte) (int, bool) {
	rp, err := ygo.DecodeRelativePosition(enc)
	if err != nil {
		return 0, false
	}
	abs, ok := ygo.CreateAbsolutePositionFromRelativePosition(c.d, rp)
	if !ok {
		return 0, false
	}
	return int(abs.Index), true
}

type attributionRun struct {
	clientID uint64
	text     string
}

// attribution lists the visible text in order, split by the client that inserted it.
func (c *crdtDoc) attribution() []attributionRun {
	t := ygo.NewText(c.d, textName)
	txn := c.d.ReadTxn()
	defer txn.Close()
	var out []attributionRun
	for it := t.Branch().Start; it != nil; it = it.Right {
		if it.IsDeleted() || it.Content.Str == "" {
			continue
		}
		if n := len(out); n > 0 && out[n-1].clientID == it.ID.Client {
			out[n-1].text += it.Content.Str
			continue
		}
		out = append(out, attributionRun{clientID: it.ID.Client, text: it.Content.Str})
	}
	return out
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// byteOffset converts a UTF-16 index into a byte offset in s, clamped to len(s).
func byteOffset(s string, idx int) int {
	u := 0
	for i, r := range s {
		if u >= idx {
			return i
		}
		if r >= 0x10000 {
			u += 2
		} else {
			u++
		}
	}
	return len(s)
}

func utf16Offset(s string, byteOff int) int {
	if byteOff > len(s) {
		byteOff = len(s)
	}
	return utf16Len(s[:byteOff])
}

// Replay applies updates on top of state and returns the new state and its text.
func Replay(state []byte, updates [][]byte) ([]byte, string, error) {
	d := newCRDT(0)
	if len(state) > 0 {
		if err := d.apply(state, nil); err != nil {
			return nil, "", err
		}
	}
	for _, u := range updates {
		if err := d.apply(u, nil); err != nil {
			return nil, "", err
		}
	}
	return d.state(), d.text(), nil
}

// EditUpdate returns the update that turns the text of state into newText, authored by clientID.
func EditUpdate(state []byte, clientID uint64, newText string) ([]byte, error) {
	up, _, _, err := editFrom(state, clientID, func(*crdtDoc) (string, error) { return newText, nil })
	return up, err
}
