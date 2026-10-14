import { describe, expect, it } from 'vitest'
import { splitSlides } from '@/render/slides'

describe('splitSlides', () => {
  it('splits on --- and ---- and keeps speaker notes apart', () => {
    const s = splitSlides('---\ntype: slide\n---\n# One\nnote:\nsay hi\n---\n# Two\n----\n## Two down\n---\n```\n---\n```')
    expect(s).toHaveLength(3)
    expect(s[0].body.trim()).toBe('# One')
    expect(s[0].notes.trim()).toBe('say hi')
    expect(s[1].vertical.map((v) => v.body.trim())).toEqual(['# Two', '## Two down'])
    expect(s[2].body).toContain('---')
  })
})
