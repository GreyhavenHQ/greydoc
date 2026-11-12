import { describe, expect, it } from 'vitest'
import { atomicAround, cellMarkdown, markdownSelection, richCell } from '@/editor/cellhtml'

const md = (html: string) => {
  const el = document.createElement('td')
  el.innerHTML = html
  return cellMarkdown(el)
}

describe('cell HTML to Markdown', () => {
  it('writes the inline marks', () => {
    expect(md('a <strong>b</strong> <em>c</em> <s>d</s> <code>e</code> <mark>f</mark>')).toBe('a **b** *c* ~~d~~ `e` ==f==')
    expect(md('<strong><em>both</em></strong>')).toBe('***both***')
    expect(md('<a href="https://x.example">site</a> and <a href="https://y.example">https://y.example</a>')).toBe('[site](https://x.example) and https://y.example')
  })
  it('escapes characters that would become marks', () => {
    expect(md('2 * 3 and [x] and a`b')).toBe('2 \\* 3 and \\[x\\] and a\\`b')
    expect(md('snake_case')).toBe('snake_case')
  })
  it('ignores the line break a browser adds to an empty cell', () => {
    expect(md('<br>')).toBe('')
    expect(md('x<br>')).toBe('x')
  })
  it('writes images, links to documents and mentions', () => {
    expect(md('<img src="/uploads/0123456789abcdef0123456789abcdef.png?w=1600" alt="dot">')).toBe('![dot](/uploads/0123456789abcdef0123456789abcdef.png)')
    expect(md('<a href="/n/xy" class="note-link" data-alias="xy" data-label="1">Title</a>')).toBe('[[xy|Title]]')
    expect(md('<a href="/n/xy" class="note-link" data-alias="xy">xy</a>')).toBe('[[xy]]')
    expect(md('<span class="mention" data-user="ana">@Ana M</span>')).toBe('[@Ana M](@ana)')
  })
  it('gives null for content it cannot write back', () => {
    expect(md('<img src="a.png" width="20">')).toBeNull()
    expect(md('<span class="katex">x</span>')).toBeNull()
  })
})

describe('markdownSelection', () => {
  it('gives the selection of a rendered cell as offsets in its Markdown', () => {
    const el = document.createElement('td')
    el.innerHTML = 'a <strong>bold</strong> c'
    document.body.appendChild(el)
    const r = document.createRange()
    r.setStart(el.querySelector('strong')!.firstChild!, 1)
    r.setEnd(el.lastChild!, 2)
    expect(markdownSelection(el, r)).toEqual({ markdown: 'a **bold** c', from: 5, to: 12 })
    expect(el.innerHTML).toBe('a <strong>bold</strong> c')
    const caret = document.createRange()
    caret.setStart(el.lastChild!, 2)
    expect(markdownSelection(el, caret)).toEqual({ markdown: 'a **bold** c', from: 12, to: 12 })
    caret.setStart(el.firstChild!, 1)
    caret.collapse(true)
    expect(markdownSelection(el, caret)).toEqual({ markdown: 'a **bold** c', from: 1, to: 1 })
  })
})

describe('atomic content in a cell', () => {
  const cell = (html: string) => {
    const el = document.createElement('td')
    el.innerHTML = html
    document.body.appendChild(el)
    return el
  }
  it('gives no offsets when a mark is lost in content written from its attributes', () => {
    const el = cell('see <a href="/n/xy" class="note-link" data-alias="xy">xy</a>')
    const r = document.createRange()
    r.setStart(el.querySelector('a')!.firstChild!, 1)
    expect(markdownSelection(el, r)).toBeNull()
  })
  it('selects a whole link to a document, a mention or an image around the caret', () => {
    const el = cell('see <a href="/n/xy" class="note-link" data-alias="xy">xy</a> and <span class="mention" data-user="ana">@Ana</span>')
    const r = document.createRange()
    r.setStart(el.querySelector('a')!.firstChild!, 1)
    atomicAround(el, r)
    expect(markdownSelection(el, r)).toEqual({ markdown: 'see [[xy]] and [@Ana](@ana)', from: 4, to: 10 })
    r.setStart(el.querySelector('span')!.firstChild!, 2)
    r.collapse(true)
    atomicAround(el, r)
    expect(markdownSelection(el, r)).toEqual({ markdown: 'see [[xy]] and [@Ana](@ana)', from: 15, to: 27 })
  })
})

describe('richCell', () => {
  it('accepts a cell that comes back unchanged', () => {
    expect(richCell('Europe')).toBe(true)
    expect(richCell('**Asia** and *open*')).toBe(true)
    expect(richCell('[Q4](https://example.com)')).toBe(true)
    expect(richCell('[[xy|Title]] ![dot](/uploads/0123456789abcdef0123456789abcdef.png)')).toBe(true)
    expect(richCell('')).toBe(true)
  })
  it('refuses a cell whose source would change', () => {
    expect(richCell('__bold__')).toBe(false)
    expect(richCell('![img](a.png =20x)')).toBe(false)
    expect(richCell('$x^2$')).toBe(false)
  })
})
