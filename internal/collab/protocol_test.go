package collab

import (
	"bytes"
	"testing"
)

func TestVarUintRoundTrip(t *testing.T) {
	for _, v := range []uint64{0, 1, 127, 128, 300, 1 << 32, 1<<53 - 1} {
		var b []byte
		b = appendVarUint(b, v)
		r := &reader{buf: b}
		got, err := r.varUint()
		if err != nil || got != v || r.pos != len(b) {
			t.Fatalf("%d: got %d err %v", v, got, err)
		}
	}
}

func TestSyncMessageRoundTrip(t *testing.T) {
	payload := []byte{1, 2, 3}
	for _, mk := range []func([]byte) []byte{encodeSyncStep1, encodeSyncStep2, encodeSyncUpdate} {
		msg := mk(payload)
		m, err := decodeMessage(msg)
		if err != nil || m.typ != msgSync || !bytes.Equal(m.data, payload) {
			t.Fatalf("%+v %v", m, err)
		}
	}
	m, _ := decodeMessage(encodeSyncStep2(payload))
	if m.syncType != syncStep2 {
		t.Fatalf("sync type %d", m.syncType)
	}
}

func TestAwarenessRoundTrip(t *testing.T) {
	in := []awarenessEntry{{clientID: 7, clock: 3, state: `{"user":{"name":"a"}}`}, {clientID: 9, clock: 1, state: "null"}}
	out, err := decodeAwareness(encodeAwareness(in))
	if err != nil || len(out) != 2 || out[0] != in[0] || out[1] != in[1] {
		t.Fatalf("%+v %v", out, err)
	}
}

func TestDecodeStateVector(t *testing.T) {
	var b []byte
	b = appendVarUint(b, 2)
	b = appendVarUint(b, 11)
	b = appendVarUint(b, 5)
	b = appendVarUint(b, 22)
	b = appendVarUint(b, 9)
	sv, err := decodeStateVector(b)
	if err != nil || sv[11] != 5 || sv[22] != 9 || len(sv) != 2 {
		t.Fatalf("%v %v", sv, err)
	}
}

func TestDecodeTruncatedFails(t *testing.T) {
	if _, err := decodeMessage([]byte{0, 2, 5, 1}); err == nil {
		t.Fatal("truncated message decoded")
	}
	if _, err := decodeAwareness([]byte{1, 7}); err == nil {
		t.Fatal("truncated awareness decoded")
	}
}
