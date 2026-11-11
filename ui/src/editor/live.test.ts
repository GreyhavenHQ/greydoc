import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { liveDecorations, liveStyle, type LiveStyle } from '@/editor/live'

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

function hidden(cursor: number, style: LiveStyle = 'obsidian') {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), liveStyle.of(style)],
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

  it('keeps blank lines small under a selection, and full height under the cursor', () => {
    const src = 'a\n\nb\n\nc'
    const state = (sel: EditorSelection) => EditorState.create({ doc: src, selection: sel, extensions: [markdown({ base: markdownLanguage })] })
    const blanks = (sel: EditorSelection) => {
      const out: number[] = []
      liveDecorations(state(sel)).between(0, src.length, (from, _to, d) => {
        if (d.spec.class === 'cm-lp-blank') out.push(src.slice(0, from).split('\n').length)
      })
      return out
    }
    expect(blanks(EditorSelection.single(0, src.length))).toEqual([2, 4])
    expect(blanks(EditorSelection.single(2))).toEqual([4])
  })

  it('marks blank lines outside code', () => {
    const src = 'a\n\n```\n\n```\n\nb'
    const blank = decos(src, 0).filter((d) => d.cls === 'cm-lp-blank').map((d) => src.slice(0, d.from).split('\n').length)
    expect(blank).toEqual([2, 6])
  })

  it('keeps marks hidden on the active line in the document style', () => {
    let texts = hidden(at('**bold**') + 3, 'document').map((x) => x.text)
    expect(texts).toContain('**')
    expect(texts).toContain('](https://x.example)')
    texts = hidden(at('# Title') + 3, 'document').map((x) => x.text)
    expect(texts).toContain('# ')
    // Diagrams and front matter still show their source for editing.
    expect(hidden(at('A-->B'), 'document').some((x) => x.widget === 'MermaidWidget')).toBe(false)
    expect(hidden(at('tags'), 'document').some((x) => x.widget === 'FrontMatterWidget')).toBe(false)
  })

  describe('the extra syntax of the view', () => {
    const src = [
      '[toc]',
      '# Syntax',
      '++inserted++ H~2~O x^2^ :smile: [[zz-target|Target]] [[other]] claim[^1]',
      ':::info\nAlso success.\n:::',
      ':::spoiler Click\nHidden.\n:::',
      'Term\n: What it means.',
      '```csvpreview header="true"\nname,team\nAna,Search\n```',
      '<details><summary>More</summary>Inside</details>',
      '[^1]: The source.',
      'end',
    ].join('\n\n')
    const ds = decos(src)
    const widget = (name: string, text: string) => ds.find((d) => d.widget === name && d.text.startsWith(text))

    it('renders the blocks as the view does', () => {
      expect(widget('HTMLBlockWidget', '[toc]')).toBeTruthy()
      expect(widget('HTMLBlockWidget', ':::info')?.text).toBe(':::info\nAlso success.\n:::')
      expect(widget('HTMLBlockWidget', ':::spoiler')).toBeTruthy()
      expect(widget('HTMLBlockWidget', 'Term')?.text).toBe('Term\n: What it means.')
      expect(widget('HTMLBlockWidget', '```csvpreview')).toBeTruthy()
      expect(widget('HTMLBlockWidget', '<details>')).toBeTruthy()
    })

    it('shows the source of a block under the cursor', () => {
      const at = src.indexOf('Also success')
      expect(decos(src, at).some((d) => d.widget === 'HTMLBlockWidget' && d.text.startsWith(':::info'))).toBe(false)
    })

    it('renders the inline marks of the view', () => {
      const cls = (name: string) => ds.filter((d) => d.cls.includes(name)).map((d) => d.text)
      expect(cls('cm-lp-ins')).toEqual(['inserted'])
      expect(cls('cm-lp-sub')).toEqual(['2'])
      expect(cls('cm-lp-sup')).toEqual(['2'])
      expect(ds.find((d) => d.text === ':smile:')?.label).toBe('😄')
      expect(ds.find((d) => d.text === '[[zz-target|Target]]')?.label).toBe('Target')
      expect(ds.find((d) => d.text === '[[other]]')?.label).toBe('other')
      expect(ds.find((d) => d.text === '[^1]')?.label).toBe('1')
      expect(ds.find((d) => d.text === '[^1]:')?.label).toBe('1.')
    })
  })
})
