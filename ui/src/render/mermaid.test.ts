import { describe, expect, it, vi } from 'vitest'

const render = vi.fn(async (_id: string, src: string) => ({ svg: `<svg>${src}</svg>` }))
vi.mock('mermaid', () => ({ default: { registerLayoutLoaders: vi.fn(), initialize: vi.fn(), render } }))
vi.mock('@mermaid-js/layout-elk', () => ({ default: [] }))

import { hydrateMermaid } from '@/render/mermaid'

function preview(src: string) {
  const root = document.createElement('div')
  root.innerHTML = '<div class="mermaid-block"><pre class="mermaid-source"></pre></div>'
  root.querySelector('.mermaid-source')!.textContent = src
  document.body.replaceChildren(root)
  return root
}

describe('hydrateMermaid', () => {
  it('skips the renders of sources that the preview no longer shows', async () => {
    const jobs = ['graph', 'graph TD', 'graph TD\nA --> B'].map((src) => hydrateMermaid(preview(src), { interactive: false }))
    await Promise.all(jobs)
    expect(render.mock.calls.map((c) => c[1])).toEqual(['graph TD\nA --> B'])
    expect(document.querySelector('.mermaid-block svg')!.textContent).toBe('graph TD\nA --> B')
  })
})
