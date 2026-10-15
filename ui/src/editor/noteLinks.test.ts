import { describe, expect, it } from 'vitest'
import { noteLink } from '@/editor/noteLinks'
import { renderMarkdown } from '@/render/markdown'

describe('note links', () => {
  it('writes the title next to the address', () => {
    expect(noteLink({ alias: '0g7pyz04w2', title: 'Q4 platform roadmap' })).toBe('[[0g7pyz04w2|Q4 platform roadmap]]')
  })
  it('keeps the link intact when the title has ] or |', () => {
    const link = noteLink({ alias: 'x1', title: 'A [draft] | v2' })
    expect(link).toBe('[[x1|A [draft v2]]')
    expect(renderMarkdown(link).html).toContain('href="/n/x1"')
  })
  it('leaves out a title that adds nothing', () => {
    expect(noteLink({ alias: 'q4', title: '' })).toBe('[[q4]]')
    expect(noteLink({ alias: 'q4', title: 'q4' })).toBe('[[q4]]')
  })
})
