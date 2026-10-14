package collab

import (
	"errors"
	"unicode/utf16"
)

type clockRange struct{ start, end uint64 }

var errUnknownContent = errors.New("unknown struct content")

// updateClockRanges reads the struct section of a Yjs V1 update and returns, per client,
// the clock range its structs cover. The delete set is not read.
func updateClockRanges(update []byte) (map[uint64]clockRange, error) {
	r := &reader{buf: update}
	nClients, err := r.varUint()
	if err != nil {
		return nil, err
	}
	if nClients > uint64(len(update)) {
		return nil, errTruncated
	}
	out := make(map[uint64]clockRange, nClients)
	for i := uint64(0); i < nClients; i++ {
		nStructs, err := r.varUint()
		if err != nil {
			return nil, err
		}
		client, err := r.varUint()
		if err != nil {
			return nil, err
		}
		clock, err := r.varUint()
		if err != nil {
			return nil, err
		}
		if nStructs > uint64(len(update)) {
			return nil, errTruncated
		}
		start := clock
		for j := uint64(0); j < nStructs; j++ {
			n, err := r.structLen()
			if err != nil {
				return nil, err
			}
			clock += n
		}
		cr := out[client]
		if _, seen := out[client]; !seen || start < cr.start {
			cr.start = start
		}
		cr.end = max(cr.end, clock)
		out[client] = cr
	}
	return out, nil
}

func (r *reader) byte1() (byte, error) {
	if r.pos >= len(r.buf) {
		return 0, errTruncated
	}
	b := r.buf[r.pos]
	r.pos++
	return b, nil
}

func (r *reader) skipID() error {
	if _, err := r.varUint(); err != nil {
		return err
	}
	_, err := r.varUint()
	return err
}

// structLen skips one struct and returns how many clock units it covers.
func (r *reader) structLen() (uint64, error) {
	info, err := r.byte1()
	if err != nil {
		return 0, err
	}
	ref := info & 0x1f
	if ref == 0 || ref == 10 {
		return r.varUint()
	}
	hasOrigin, hasRight := info&0x80 != 0, info&0x40 != 0
	if hasOrigin {
		if err := r.skipID(); err != nil {
			return 0, err
		}
	}
	if hasRight {
		if err := r.skipID(); err != nil {
			return 0, err
		}
	}
	if !hasOrigin && !hasRight {
		named, err := r.varUint()
		if err != nil {
			return 0, err
		}
		if named == 1 {
			if _, err := r.varString(); err != nil {
				return 0, err
			}
		} else if err := r.skipID(); err != nil {
			return 0, err
		}
		if info&0x20 != 0 {
			if _, err := r.varString(); err != nil {
				return 0, err
			}
		}
	}
	return r.contentLen(ref)
}

func (r *reader) contentLen(ref byte) (uint64, error) {
	switch ref {
	case 1: // deleted
		return r.varUint()
	case 2: // json
		n, err := r.varUint()
		if err != nil {
			return 0, err
		}
		for i := uint64(0); i < n; i++ {
			if _, err := r.varBytes(); err != nil {
				return 0, err
			}
		}
		return n, nil
	case 3: // binary
		_, err := r.varBytes()
		return 1, err
	case 4: // string
		s, err := r.varString()
		if err != nil {
			return 0, err
		}
		return uint64(len(utf16.Encode([]rune(s)))), nil
	case 5: // embed
		_, err := r.varBytes()
		return 1, err
	case 6: // format
		if _, err := r.varBytes(); err != nil {
			return 0, err
		}
		_, err := r.varBytes()
		return 1, err
	case 7: // type
		typeRef, err := r.varUint()
		if err != nil {
			return 0, err
		}
		if typeRef == 3 || typeRef == 5 {
			_, err = r.varBytes()
		}
		return 1, err
	case 8: // any
		n, err := r.varUint()
		if err != nil {
			return 0, err
		}
		for i := uint64(0); i < n; i++ {
			if err := r.skipAny(0); err != nil {
				return 0, err
			}
		}
		return n, nil
	case 9: // doc
		if _, err := r.varBytes(); err != nil {
			return 0, err
		}
		return 1, r.skipAny(0)
	}
	return 0, errUnknownContent
}

// skipAny skips one lib0 "any" value.
func (r *reader) skipAny(depth int) error {
	if depth > 64 {
		return errors.New("any nested too deep")
	}
	t, err := r.byte1()
	if err != nil {
		return err
	}
	switch t {
	case 127, 126, 121, 120: // undefined, null, false, true
		return nil
	case 125: // varint
		for {
			b, err := r.byte1()
			if err != nil {
				return err
			}
			if b&0x80 == 0 {
				return nil
			}
		}
	case 124:
		return r.skip(4)
	case 123, 122:
		return r.skip(8)
	case 119, 116: // string, bytes
		_, err := r.varBytes()
		return err
	case 118: // object
		n, err := r.varUint()
		if err != nil {
			return err
		}
		for i := uint64(0); i < n; i++ {
			if _, err := r.varBytes(); err != nil {
				return err
			}
			if err := r.skipAny(depth + 1); err != nil {
				return err
			}
		}
		return nil
	case 117: // array
		n, err := r.varUint()
		if err != nil {
			return err
		}
		for i := uint64(0); i < n; i++ {
			if err := r.skipAny(depth + 1); err != nil {
				return err
			}
		}
		return nil
	}
	return errUnknownContent
}

func (r *reader) skip(n int) error {
	if len(r.buf)-r.pos < n {
		return errTruncated
	}
	r.pos += n
	return nil
}
