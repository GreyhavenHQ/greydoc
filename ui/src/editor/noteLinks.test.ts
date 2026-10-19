import { describe, expect, it } from 'vitest'
import { CompletionContext, type Completion } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { headingLink, noteLink, noteLinkSource } from '@/editor/noteLinks'
import { renderMarkdown } from '@/render/markdown'

describe('note links', () => {
  it('writes the title next to the address', () => {
    expect(noteLink({ alias: '0g7pyz04w2', title: 'Q4 platform roadmap' })).toBe('[[0g7pyz04w2|Q4 platform roadmap]]')
  })
  it('keeps the link intact when the title has ] or |', () => {
    const link = noteLink({ alias: 'x1', title: 'A [draft] | v2' })
    expect(link).toBe('[[x1|A [draft v2]]')
    expect(renderMarkdown(link).html).toContain('href="/n/x1"')
  })
  it('leaves out a title that adds nothing', () => {
    expect(noteLink({ alias: 'q4', title: '' })).toBe('[[q4]]')
    expect(noteLink({ alias: 'q4', title: 'q4' })).toBe('[[q4]]')
  })
  it('writes the heading text next to the section', () => {
    expect(headingLink('q4', { id: 'release-plan', text: 'Release plan' })).toBe('[[q4#release-plan|Release plan]]')
    expect(headingLink('q4', { id: 'a', text: '' })).toBe('[[q4#a]]')
  })
})

describe('heading completion', () => {
  const headings = async (alias: string) =>
    alias === 'q4'
      ? [
          { level: 1, text: 'Q4 roadmap', id: 'q4-roadmap' },
          { level: 2, text: 'Release plan', id: 'release-plan' },
        ]
      : []
  const source = noteLinkSource(async () => [{ alias: 'q4', title: 'Q4 roadmap' }], () => 'self', headings)

  async function complete(doc: string) {
    const state = EditorState.create({ doc })
    return { state, result: await source(new CompletionContext(state, doc.length, false)) }
  }

  it('lists the headings of the note after [[alias#', async () => {
    const { result } = await complete('See [[q4#rel')
    expect(result?.options.map((o) => [o.label, o.detail])).toEqual([
      ['Q4 roadmap', 'q4-roadmap'],
      ['Release plan', 'release-plan'],
    ])
    expect(result?.from).toBe('See [[q4#'.length)
  })
  it('still lists notes after [[', async () => {
    const { result } = await complete('See [[q')
    expect(result?.options.map((o) => o.label)).toEqual(['Q4 roadmap'])
  })
  it('gives nothing for a note with no headings', async () => {
    expect((await complete('[[other#')).result).toBeNull()
  })
  for (const tail of ['', ']]']) {
    it(`inserts [[alias#id|Text]] with ${tail || 'no'} closing brackets after the cursor`, async () => {
      const doc = 'See [[q4#rel'
      const view = new EditorView({ state: EditorState.create({ doc: doc + tail, selection: { anchor: doc.length } }) })
      const result = await source(new CompletionContext(view.state, doc.length, false))
      const opt = result!.options[1] as Completion & { apply: (v: EditorView, c: Completion, from: number, to: number) => void }
      opt.apply(view, opt, result!.from, doc.length)
      expect(view.state.doc.toString()).toBe('See [[q4#release-plan|Release plan]]')
      view.destroy()
    })
  }
})
