import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '@/render/markdown'
import { applyThreadMarks, clearThreadMarks } from '@/render/previewThreads'

function mount(source: string): HTMLElement {
  const el = document.createElement('article')
  el.innerHTML = renderMarkdown(source).html
  document.body.replaceChildren(el)
  return el
}

const marked = (article: HTMLElement) => Array.from(article.querySelectorAll<HTMLElement>('span.preview-thread'), (s) => s.textContent).join('|')

describe('applyThreadMarks', () => {
  const src = 'The **budget** is final.\n\n$$\nx\n$$'
  const range = (needle: string) => ({ from: src.indexOf(needle), to: src.indexOf(needle) + needle.length })

  it('wraps the rendered text of each thread', () => {
    const article = mount(src)
    applyThreadMarks(article, src, [{ id: 't1', ...range('budget** is'), active: false }])
    expect(marked(article)).toBe('budget| is')
    expect(article.querySelector('p')!.textContent).toBe('The budget is final.')
    expect(article.querySelectorAll('[data-thread="t1"]')).toHaveLength(2)
  })
  it('marks a block when its text does not match', () => {
    const article = mount(src)
    applyThreadMarks(article, src, [{ id: 'm', ...range('$$\nx\n$$'), active: true }])
    const block = article.querySelector('.preview-thread-block')!
    expect(block.classList.contains('katex-block')).toBe(true)
    expect(block.classList.contains('preview-thread-active')).toBe(true)
    expect(block.getAttribute('data-thread')).toBe('m')
  })
  it('marks overlapping threads and prefers the active one', () => {
    const article = mount(src)
    applyThreadMarks(article, src, [
      { id: 'a', ...range('budget** is'), active: false },
      { id: 'b', ...range('is final'), active: true },
    ])
    expect(marked(article)).toBe('budget| |is| final')
    expect(article.querySelector('.preview-thread-active')!.textContent).toBe('is')
    expect(article.querySelector('.preview-thread-active')!.getAttribute('data-thread')).toBe('b')
  })
  it('reapplies without nesting and clears', () => {
    const article = mount(src)
    const html = article.innerHTML
    const threads = [{ id: 't1', ...range('final'), active: false }]
    applyThreadMarks(article, src, threads)
    applyThreadMarks(article, src, threads)
    expect(article.querySelectorAll('.preview-thread')).toHaveLength(1)
    expect(article.querySelectorAll('.preview-thread .preview-thread')).toHaveLength(0)
    clearThreadMarks(article)
    expect(article.innerHTML).toBe(html)
  })
})
