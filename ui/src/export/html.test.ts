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

describe('standaloneHTML width', () => {
  it('uses a 728px text column, or 1200px for a wide document', () => {
    const article = document.createElement('article')
    expect(standaloneHTML('A', article)).toContain('main{max-width:728px;')
    expect(standaloneHTML('A', article, 'wide')).toContain('main{max-width:1200px;')
  })
})
