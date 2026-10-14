import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { captureEdits, type PendingEdit } from '@/editor/suggestions'

describe('captureEdits', () => {
  it('turns typing into a pending replacement and leaves the text alone', () => {
    let got: PendingEdit | null = null
    const state = EditorState.create({ doc: 'The plan is bad.', extensions: [captureEdits(() => true, (e) => (got = e))] })
    const tr = state.update({ changes: { from: 12, to: 15, insert: 'good' }, userEvent: 'input.type' })
    expect(tr.state.doc.toString()).toBe('The plan is bad.')
    expect(got).toEqual({ from: 12, to: 15, original: 'bad', proposed: 'good' })
  })
  it('lets remote and inactive changes through', () => {
    let calls = 0
    let active = false
    const state = EditorState.create({ doc: 'abc', extensions: [captureEdits(() => active, () => calls++)] })
    expect(state.update({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' }).state.doc.toString()).toBe('xabc')
    active = true
    expect(state.update({ changes: { from: 0, insert: 'y' } }).state.doc.toString()).toBe('yabc')
    expect(calls).toBe(0)
  })
})
