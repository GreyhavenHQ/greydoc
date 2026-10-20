import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '@/render/markdown'
import { align, selectionToSource, sourceToRendered } from '@/render/sourceMap'

function mount(source: string): HTMLElement {
  const el = document.createElement('article')
  el.innerHTML = renderMarkdown(source).html
  document.body.replaceChildren(el)
  return el
}

// select builds a DOM range over the n-th occurrence of needle in the article's text.
function select(article: HTMLElement, needle: string, nth = 0): Range {
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
  const all = nodes.map((n) => n.data).join('')
  let at = -1
  for (let i = 0; i <= nth; i++) at = all.indexOf(needle, at + 1)
  if (at < 0) throw new Error('not found: ' + needle)
  const point = (pos: number, end: boolean): [Text, number] => {
    let acc = 0
    for (const n of nodes) {
      if (pos < acc + n.length || (end && pos === acc + n.length)) return [n, pos - acc]
      acc += n.length
    }
    throw new Error('out of range')
  }
  const r = document.createRange()
  r.setStart(...point(at, false))
  r.setEnd(...point(at + needle.length, true))
  return r
}

function sourceOf(source: string, needle: string, nth = 0) {
  const article = mount(source)
  const m = selectionToSource(article, select(article, needle, nth), source)
  return m && { text: source.slice(m.from, m.to), exact: m.exact, quote: m.quote }
}

describe('align', () => {
  it('skips Markdown syntax', () => {
    const map = align('a b', '**a** b', [])
    expect(map).toEqual([2, 5, 6])
  })
  it('leaves characters without a source as -1', () => {
    expect(align('x😄', 'x :smile:', [])).toEqual([0, -1, -1])
  })
})

describe('selectionToSource', () => {
  it('maps a plain paragraph exactly', () => {
    expect(sourceOf('Hello world.', 'world')).toEqual({ text: 'world', exact: true, quote: 'world' })
  })
  it('maps through bold to the source text', () => {
    expect(sourceOf('The **budget** is final.', 'budget is final')).toMatchObject({ text: 'budget** is final', exact: true })
  })
  it('maps link text and skips the URL', () => {
    expect(sourceOf('See [the docs](https://example.com/a/b) now.', 'docs now')).toMatchObject({
      text: 'docs](https://example.com/a/b) now',
      exact: true,
    })
  })
  it('maps the second of two equal words to its own place', () => {
    const src = 'one word\n\nanother word'
    const article = mount(src)
    const m = selectionToSource(article, select(article, 'word', 1), src)!
    expect(m.from).toBe(src.lastIndexOf('word'))
  })
  it('maps a selection across two paragraphs', () => {
    expect(sourceOf('First para.\n\nSecond para.', 'para.\nSecond')).toMatchObject({ text: 'para.\n\nSecond', exact: true })
  })
  it('maps list items and headings', () => {
    expect(sourceOf('# Title here\n\n- one\n- two items', 'two')).toMatchObject({ text: 'two', exact: true })
    expect(sourceOf('# Title here\n\n- one', 'Title')).toMatchObject({ text: 'Title', exact: true })
  })
  it('maps code fences', () => {
    expect(sourceOf('```js\nconst x = 1\n```', 'x = 1')).toMatchObject({ text: 'x = 1', exact: true })
  })
  it('ignores generated labels, lowercased links and inline math', () => {
    expect(sourceOf('> [!NOTE]\n> Useful information.', 'information')).toMatchObject({ text: 'information', exact: true })
    expect(sourceOf('See [[Q4-Roadmap]] today.', 'today')).toMatchObject({ text: 'today', exact: true })
    expect(sourceOf('Inline $x^2$ and more', 'and more')).toMatchObject({ text: 'and more', exact: true })
    expect(sourceOf('Inline $x^2$ and more', 'Inline')).toMatchObject({ text: 'Inline', exact: true })
  })
  it('counts the front matter lines', () => {
    const src = '---\ntitle: X\n---\nBody text'
    const article = mount(src)
    const m = selectionToSource(article, select(article, 'text'), src)!
    expect(m).toMatchObject({ from: src.indexOf('text'), exact: true })
  })
  it('falls back to the block lines in math', () => {
    const src = 'Before.\n\n$$\n\\frac{a}{b}\n$$\n\nAfter.'
    const article = mount(src)
    const katex = article.querySelector('.katex-display')!
    const r = document.createRange()
    r.selectNodeContents(katex)
    const m = selectionToSource(article, r, src)!
    expect(m.exact).toBe(false)
    expect(src.slice(m.from, m.to)).toBe('$$\n\\frac{a}{b}\n$$')
    expect(m.quote).toBe('\\frac{a}{b}')
  })
  it('returns null outside source blocks', () => {
    const article = mount('text')
    const r = document.createRange()
    r.setStart(article, 0)
    r.setEnd(article, 0)
    expect(selectionToSource(article, r, 'text')).toBeNull()
  })
})

describe('sourceToRendered', () => {
  const texts = (pieces: ReturnType<typeof sourceToRendered>) =>
    pieces.ranges.map((p) => p.node.data.slice(p.start, p.end)).join('|')

  it('round-trips exact selections', () => {
    for (const [src, needle] of [
      ['The **budget** is final.', 'budget is final'],
      ['See [the docs](https://example.com) now.', 'docs now'],
      ['First para.\n\nSecond para.', 'para.\nSecond'],
    ]) {
      const article = mount(src)
      const m = selectionToSource(article, select(article, needle), src)!
      expect(texts(sourceToRendered(article, m.from, m.to, src)).replace(/[|\s]/g, '')).toBe(needle.replace(/\s/g, ''))
    }
  })
  it('marks a math block as a whole', () => {
    const src = 'Before.\n\n$$\nx\n$$\n\nAfter.'
    const article = mount(src)
    const from = src.indexOf('$$')
    const out = sourceToRendered(article, from, src.lastIndexOf('$$') + 2, src)
    expect(out.ranges).toHaveLength(0)
    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0].querySelector('.katex-display')).not.toBeNull()
  })
})
