import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { liveDecorations } from '@/editor/live'

const doc = [
  '---',
  'tags: [a]',
  '---',
  '# Title',
  '',
  'Some **bold** and [a link](https://x.example).',
  '',
  '- [ ] task',
  '',
  '[toc] and ==marked==',
  '',
  '```mermaid',
  'graph TD',
  'A-->B',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  'end',
].join('\n')

function hidden(cursor: number) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage })],
  })
  const out: { from: number; to: number; text: string; widget: string; block: boolean }[] = []
  liveDecorations(state).between(0, doc.length, (from, to, d) => {
    const spec = d.spec as { widget?: { constructor: { name: string } }; block?: boolean }
    if (d.spec.class || d.spec.attributes) return
    out.push({ from, to, text: doc.slice(from, to), widget: spec.widget?.constructor.name ?? '', block: !!spec.block })
  })
  return out
}

const at = (needle: string) => doc.indexOf(needle)

describe('live preview', () => {
  it('hides markup away from the cursor and renders blocks', () => {
    const h = hidden(doc.length)
    const texts = h.map((x) => x.text)
    expect(texts).toContain('# ')
    expect(texts).toContain('**')
    expect(texts).toContain('](https://x.example)')
    expect(texts).toContain('[')
    expect(h.find((x) => x.text.startsWith('```mermaid'))?.block).toBe(true)
    expect(h.find((x) => x.text.startsWith('| a |'))?.block).toBe(true)
    expect(h.find((x) => x.text === '[ ]')?.widget).toBe('CheckboxWidget')
    const fm = h.find((x) => x.from === 0)
    expect(fm?.widget).toBe('FrontMatterWidget')
    expect(fm?.block).toBe(true)
    expect(fm?.text).toBe('---\ntags: [a]\n---')
    expect(texts).not.toContain('[toc]')
    expect(texts.filter((t) => t === '==')).toHaveLength(2)
  })

  it('shows the source of the line or block that holds the cursor', () => {
    let texts = hidden(at('# Title') + 3).map((x) => x.text)
    expect(texts).not.toContain('# ')
    expect(texts).toContain('**')
    expect(hidden(at('tags')).some((x) => x.widget === 'FrontMatterWidget')).toBe(false)
    texts = hidden(at('A-->B')).map((x) => x.text)
    expect(texts.some((t) => t.startsWith('```mermaid'))).toBe(false)
    expect(texts).toContain('# ')
  })
})
