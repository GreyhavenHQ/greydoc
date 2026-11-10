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

type Deco = { from: number; to: number; text: string; cls: string; style: string; widget: string; label: string }

function decos(src: string, cursor = src.length): Deco[] {
  const state = EditorState.create({ doc: src, selection: EditorSelection.cursor(cursor), extensions: [markdown({ base: markdownLanguage })] })
  const out: Deco[] = []
  liveDecorations(state).between(0, src.length, (from, to, d) => {
    const spec = d.spec as { class?: string; attributes?: { style?: string }; widget?: { constructor: { name: string }; text?: string; label?: string } }
    out.push({
      from,
      to,
      text: src.slice(from, to),
      cls: spec.class ?? '',
      style: spec.attributes?.style ?? '',
      widget: spec.widget?.constructor.name ?? '',
      label: spec.widget?.text ?? spec.widget?.label ?? '',
    })
  })
  return out
}

const lineOf = (src: string, ds: Deco[], needle: string) => {
  const from = src.lastIndexOf('\n', src.indexOf(needle)) + 1
  return ds.filter((d) => d.from === from && d.to === from)
}

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

  it('renders an alert title instead of its marker', () => {
    const src = '> [!NOTE]\n> Figures are unaudited.\n\nend'
    const ds = decos(src)
    const title = ds.find((d) => d.widget === 'LabelWidget')
    expect(title?.label).toBe('Note')
    expect(title?.text).toBe('> [!NOTE]')
    expect(lineOf(src, ds, '> [!NOTE]').map((d) => d.cls).join(' ')).toContain('cm-lp-first')
    expect(lineOf(src, ds, 'Figures').map((d) => d.cls).join(' ')).toContain('cm-lp-last')
  })

  it('indents list items by depth and numbers ordered items', () => {
    const src = '- top\n  - nested\n\n1. first\n\nend'
    const ds = decos(src)
    expect(lineOf(src, ds, '- top').map((d) => d.style).join('')).toContain('padding-left: 1.6em')
    expect(lineOf(src, ds, '  - nested').map((d) => d.style).join('')).toContain('padding-left: 3.2em')
    const bullets = ds.filter((d) => d.widget === 'BulletWidget')
    expect(bullets.map((b) => b.text)).toEqual(['- ', '  - ', '1. '])
    expect(bullets.map((b) => b.label)).toEqual(['•', '•', '1.'])
  })

  it('labels a code block with its language and hides the fences', () => {
    const src = '```sql\nselect 1;\n```\n\nend'
    const labels = decos(src).filter((d) => d.widget === 'LabelWidget')
    expect(labels.map((l) => [l.text, l.label])).toEqual([
      ['```sql', 'sql'],
      ['```', ''],
    ])
  })

  it('marks blank lines outside code', () => {
    const src = 'a\n\n```\n\n```\n\nb'
    const blank = decos(src, 0).filter((d) => d.cls === 'cm-lp-blank').map((d) => src.slice(0, d.from).split('\n').length)
    expect(blank).toEqual([2, 6])
  })
})
