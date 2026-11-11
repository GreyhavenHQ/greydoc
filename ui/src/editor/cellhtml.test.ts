import { describe, expect, it } from 'vitest'
import { cellMarkdown, richCell } from '@/editor/cellhtml'

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
  it('gives null for content it cannot write back', () => {
    expect(md('<img src="a.png">')).toBeNull()
    expect(md('<span class="katex">x</span>')).toBeNull()
  })
})

describe('richCell', () => {
  it('accepts a cell that comes back unchanged', () => {
    expect(richCell('Europe')).toBe(true)
    expect(richCell('**Asia** and *open*')).toBe(true)
    expect(richCell('[Q4](https://example.com)')).toBe(true)
    expect(richCell('')).toBe(true)
  })
  it('refuses a cell whose source would change', () => {
    expect(richCell('__bold__')).toBe(false)
    expect(richCell('![img](a.png)')).toBe(false)
    expect(richCell('$x^2$')).toBe(false)
  })
})
