import { describe, expect, it } from 'vitest'
import { CompletionContext, type Completion } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { chipRanges, mentionSource } from '@/editor/mentions'
import type { Person } from '@/lib/mentions'

const people: Person[] = [
  { username: 'alice', display_name: 'Alice Martin', can_read: true },
  { username: 'carol', display_name: 'Carol', can_read: false },
]

describe('mention completion', () => {
  it('offers people after @ and writes the link on pick', async () => {
    const queries: string[] = []
    const denied: string[] = []
    const source = mentionSource(
      async (q) => {
        queries.push(q)
        return people
      },
      (p) => denied.push(p.username),
    )
    const doc = 'Hi @ali'
    const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: doc.length } }) })
    const res = await source(new CompletionContext(view.state, doc.length, false))
    expect(queries).toEqual(['ali'])
    expect(res?.from).toBe(3)
    expect(res?.options.map((o) => o.label)).toEqual(['Alice Martin', 'Carol'])
    expect(res?.options[1].detail).toContain('no access')
    const apply = res!.options[0].apply as (v: EditorView, c: Completion, from: number, to: number) => void
    apply(view, res!.options[0], 3, doc.length)
    expect(view.state.doc.toString()).toBe('Hi [@Alice Martin](@alice) ')
    expect(denied).toEqual([])
    ;(res!.options[1].apply as typeof apply)(view, res!.options[1], 0, 0)
    expect(denied).toEqual(['carol'])
    view.destroy()
  })
  it('stays quiet inside a word, like an email address', async () => {
    const source = mentionSource(async () => people, () => {})
    const doc = 'mail bob@ex'
    const state = EditorState.create({ doc })
    expect(await source(new CompletionContext(state, doc.length, false))).toBeNull()
  })
})

describe('mention chips', () => {
  const ranges = (doc: string, cursor: number) => {
    const state = EditorState.create({ doc, selection: { anchor: cursor }, extensions: [markdown()] })
    return chipRanges(state, 0, doc.length).map((r) => [r.from, r.to, r.username])
  }
  it('covers each mention outside code', () => {
    const doc = 'a [@A](@alice) `[@B](@bob)` \\[@C](@carol)\n```\n[@D](@dan)\n```\n'
    expect(ranges(doc, 0)).toEqual([[2, 14, 'alice']])
  })
  it('shows the source while the cursor is inside', () => {
    const doc = 'a [@A](@alice) b'
    expect(ranges(doc, 5)).toEqual([])
    expect(ranges(doc, 2)).toEqual([[2, 14, 'alice']])
    expect(ranges(doc, 14)).toEqual([[2, 14, 'alice']])
  })
})
