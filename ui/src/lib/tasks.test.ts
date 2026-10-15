import { describe, expect, it } from 'vitest'
import { taskToggle } from '@/lib/tasks'
import { renderMarkdown } from '@/render/markdown'

const doc = ['---', 'tags: [a]', '---', '- [ ] one', '- [x] two', '  * [ ] nested', '1. [X] numbered', 'not a task [ ]'].join('\n')

describe('taskToggle', () => {
  it('finds the marker on a line and flips it', () => {
    expect(taskToggle(doc, 3)).toEqual({ offset: doc.indexOf('[ ] one') + 1, insert: 'x' })
    expect(taskToggle(doc, 4)).toEqual({ offset: doc.indexOf('[x] two') + 1, insert: ' ' })
    expect(taskToggle(doc, 5)).toEqual({ offset: doc.indexOf('[ ] nested') + 1, insert: 'x' })
    expect(taskToggle(doc, 6)).toEqual({ offset: doc.indexOf('[X] numbered') + 1, insert: ' ' })
    expect(taskToggle(doc, 7)).toBeNull()
    expect(taskToggle(doc, 99)).toBeNull()
  })
  it('matches the source line the preview puts on each task', () => {
    const div = document.createElement('div')
    div.innerHTML = renderMarkdown(doc).html
    const lines = Array.from(div.querySelectorAll('input[type=checkbox]')).map((b) => Number(b.closest('li')?.getAttribute('data-line')))
    expect(lines).toEqual([3, 4, 5, 6])
  })
})
