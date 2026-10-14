import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { anchorRange, resolveRange } from '@/editor/anchors'

describe('comment anchors', () => {
  it('follow concurrent inserts and detach when the text is deleted', () => {
    const a = new Y.Doc()
    const t = a.getText('content')
    t.insert(0, 'alpha beta gamma')
    const anchor = anchorRange(t, 6, 10)

    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    b.getText('content').insert(0, 'XXX ')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))

    const r = resolveRange(a, anchor.anchor_start, anchor.anchor_end)
    expect(r).toEqual({ from: 10, to: 14 })
    expect(t.toString().slice(r!.from, r!.to)).toBe('beta')

    t.delete(10, 4)
    expect(resolveRange(a, anchor.anchor_start, anchor.anchor_end)).toBeNull()
  })
})
