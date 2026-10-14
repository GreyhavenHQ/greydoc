import * as Y from 'yjs'

export function toBase64(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// anchorRange encodes a text range as two Yjs relative positions, start sticking right and end sticking left.
export function anchorRange(ytext: Y.Text, from: number, to: number): { anchor_start: string; anchor_end: string } {
  const a = Y.createRelativePositionFromTypeIndex(ytext, from, 0)
  const b = Y.createRelativePositionFromTypeIndex(ytext, to, -1)
  return { anchor_start: toBase64(Y.encodeRelativePosition(a)), anchor_end: toBase64(Y.encodeRelativePosition(b)) }
}

// resolveRange returns the current range of two encoded anchors, or null when the text is gone.
export function resolveRange(doc: Y.Doc, start: string, end: string): { from: number; to: number } | null {
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(start)), doc)
    const b = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(end)), doc)
    if (!a || !b || a.index >= b.index) return null
    return { from: a.index, to: b.index }
  } catch {
    return null
  }
}

// resolvePoint returns a collapsed range at an encoded anchor, for insertions.
export function resolvePoint(doc: Y.Doc, start: string): { from: number; to: number } | null {
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(start)), doc)
    return a ? { from: a.index, to: a.index } : null
  } catch {
    return null
  }
}
