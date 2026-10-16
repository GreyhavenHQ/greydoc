import { describe, expect, it } from 'vitest'
import { standaloneHTML } from '@/export/html'
import { renderMarkdown } from '@/render/markdown'

describe('standaloneHTML', () => {
  it('drops the source line anchors', () => {
    const article = document.createElement('article')
    article.innerHTML = renderMarkdown('# A\n\n| a |\n|---|\n| 1 |\n\n> quote').html
    const out = standaloneHTML('A', article)
    expect(out).toContain('<td>1</td>')
    expect(out).not.toContain('data-line')
  })
})
