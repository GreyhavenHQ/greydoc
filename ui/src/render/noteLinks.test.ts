import { describe, expect, it, vi } from 'vitest'
import { renderMarkdown } from '@/render/markdown'
import { hydrateNoteLinks, noteInfo } from '@/render/noteLinks'

vi.mock('@/lib/api', async (orig) => {
  const mod = await orig<typeof import('@/lib/api')>()
  const notes: Record<string, { title: string; content: string }> = {
    q4: { title: 'Q4 roadmap', content: '# Q4 roadmap\n\n## Release plan\n\n## Risks' },
  }
  return {
    ...mod,
    api: {
      get: async (path: string) => {
        const n = notes[decodeURIComponent(path.replace('/api/notes/', ''))]
        if (!n) throw new mod.ApiError('missing', 'not_found', 404)
        return n
      },
    },
  }
})

async function hydrated(src: string): Promise<HTMLElement> {
  const root = document.createElement('article')
  root.innerHTML = renderMarkdown(src).html
  document.body.appendChild(root)
  await hydrateNoteLinks(root)
  return root
}

describe('hydrateNoteLinks', () => {
  it('shows the title of the note', async () => {
    expect((await hydrated('[[q4]]')).querySelector('a')!.textContent).toBe('Q4 roadmap')
  })
  it('shows the title and the heading for a section link', async () => {
    const a = (await hydrated('[[q4#Release Plan]]')).querySelector('a')!
    expect(a.textContent).toBe('Q4 roadmap › Release plan')
    expect(a.classList.contains('note-link-missing')).toBe(false)
  })
  it('keeps the written text of a section link', async () => {
    expect((await hydrated('[[q4#risks|the risks]]')).querySelector('a')!.textContent).toBe('the risks')
  })
  it('marks a link to a heading that does not exist', async () => {
    const a = (await hydrated('[[q4#no-such-heading]]')).querySelector('a')!
    expect(a.classList.contains('note-link-missing')).toBe(true)
    expect(a.title).toBe('No heading with this name in the document')
  })
  it('marks a link to a note that does not exist', async () => {
    const a = (await hydrated('[[nope#x]]')).querySelector('a')!
    expect(a.title).toBe('No document has this address yet')
  })
  it('returns the headings of a note', async () => {
    expect((await noteInfo('q4'))?.headings.map((h) => h.id)).toEqual(['q4-roadmap', 'release-plan', 'risks'])
  })
})
