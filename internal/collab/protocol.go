package collab

import (
	"errors"
	"unicode/utf8"
)

// y-protocols framing over lib0 encoding, as y-websocket speaks it.

const (
	msgSync      = 0
	msgAwareness = 1
	msgAuth      = 2
	msgQueryAw   = 3
	// msgApp carries greydoc JSON events (read-only switch, deleted, comments changed).
	msgApp = 100

	syncStep1  = 0
	syncStep2  = 1
	syncUpdate = 2
)

var errTruncated = errors.New("truncated message")

func appendVarUint(b []byte, v uint64) []byte {
	for v > 0x7f {
		b = append(b, byte(v&0x7f)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

func appendVarBytes(b, data []byte) []byte {
	b = appendVarUint(b, uint64(len(data)))
	return append(b, data...)
}

type reader struct {
	buf []byte
	pos int
}

func (r *reader) varUint() (uint64, error) {
	var v uint64
	var shift uint
	for {
		if r.pos >= len(r.buf) {
			return 0, errTruncated
		}
		c := r.buf[r.pos]
		r.pos++
		v |= uint64(c&0x7f) << shift
		if c < 0x80 {
			return v, nil
		}
		shift += 7
		if shift > 63 {
			return 0, errors.New("varuint overflow")
		}
	}
}

func (r *reader) varBytes() ([]byte, error) {
	n, err := r.varUint()
	if err != nil {
		return nil, err
	}
	if uint64(len(r.buf)-r.pos) < n {
		return nil, errTruncated
	}
	out := r.buf[r.pos : r.pos+int(n)]
	r.pos += int(n)
	return out, nil
}

func (r *reader) varString() (string, error) {
	b, err := r.varBytes()
	if err != nil {
		return "", err
	}
	if !utf8.Valid(b) {
		return "", errors.New("invalid utf-8")
	}
	return string(b), nil
}

type message struct {
	typ      uint64
	syncType uint64
	data     []byte
}

func decodeMessage(b []byte) (message, error) {
	r := &reader{buf: b}
	var m message
	var err error
	if m.typ, err = r.varUint(); err != nil {
		return m, err
	}
	switch m.typ {
	case msgSync:
		if m.syncType, err = r.varUint(); err != nil {
			return m, err
		}
		m.data, err = r.varBytes()
	case msgAwareness:
		m.data, err = r.varBytes()
	}
	return m, err
}

func encodeSync(syncType uint64, data []byte) []byte {
	b := appendVarUint(nil, msgSync)
	b = appendVarUint(b, syncType)
	return appendVarBytes(b, data)
}

func encodeSyncStep1(sv []byte) []byte      { return encodeSync(syncStep1, sv) }
func encodeSyncStep2(update []byte) []byte  { return encodeSync(syncStep2, update) }
func encodeSyncUpdate(update []byte) []byte { return encodeSync(syncUpdate, update) }

func encodeAwarenessMessage(update []byte) []byte {
	return appendVarBytes(appendVarUint(nil, msgAwareness), update)
}

func encodeAppMessage(jsonPayload []byte) []byte {
	return appendVarBytes(appendVarUint(nil, msgApp), jsonPayload)
}

type awarenessEntry struct {
	clientID uint64
	clock    uint64
	state    string
}

func decodeAwareness(b []byte) ([]awarenessEntry, error) {
	r := &reader{buf: b}
	n, err := r.varUint()
	if err != nil {
		return nil, err
	}
	if n > 10000 {
		return nil, errors.New("too many awareness entries")
	}
	out := make([]awarenessEntry, 0, n)
	for i := uint64(0); i < n; i++ {
		var e awarenessEntry
		if e.clientID, err = r.varUint(); err != nil {
			return nil, err
		}
		if e.clock, err = r.varUint(); err != nil {
			return nil, err
		}
		if e.state, err = r.varString(); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

func encodeAwareness(entries []awarenessEntry) []byte {
	b := appendVarUint(nil, uint64(len(entries)))
	for _, e := range entries {
		b = appendVarUint(b, e.clientID)
		b = appendVarUint(b, e.clock)
		b = appendVarBytes(b, []byte(e.state))
	}
	return b
}

func decodeStateVector(b []byte) (map[uint64]uint64, error) {
	r := &reader{buf: b}
	n, err := r.varUint()
	if err != nil {
		return nil, err
	}
	sv := make(map[uint64]uint64, n)
	for i := uint64(0); i < n; i++ {
		c, err := r.varUint()
		if err != nil {
			return nil, err
		}
		clock, err := r.varUint()
		if err != nil {
			return nil, err
		}
		sv[c] = clock
	}
	return sv, nil
}
