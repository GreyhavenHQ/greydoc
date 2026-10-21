import { describe, expect, it } from 'vitest'
import { docWidth, isSlides, widthEdit } from './meta'

describe('isSlides', () => {
  it('reads type: slide from the front matter', () => {
    expect(isSlides('---\ntype: slide\n---\n# Deck')).toBe(true)
    expect(isSlides('---\ntype: Slides\n---\n')).toBe(true)
    expect(isSlides('---\ntype: note\n---\n')).toBe(false)
    expect(isSlides('type: slide')).toBe(false)
  })
})

describe('docWidth', () => {
  it('reads width from the front matter', () => {
    expect(docWidth('# A')).toBe('normal')
    expect(docWidth('---\nwidth: wide\n---\n')).toBe('wide')
    expect(docWidth('---\nwidth: " Wide "\n---\n')).toBe('wide')
    expect(docWidth('---\nwidth: WIDE\n---\n')).toBe('wide')
    expect(docWidth('---\nwidth: normal\n---\n')).toBe('normal')
    expect(docWidth('---\nwidth: huge\n---\n')).toBe('normal')
    expect(docWidth('---\nwidth: [wide\n---\n')).toBe('normal')
  })
})

describe('widthEdit', () => {
  const apply = (text: string, wide: boolean) => {
    const e = widthEdit(text, wide)
    return e ? text.slice(0, e.from) + e.insert + text.slice(e.to) : text
  }

  it('creates a front matter block', () => {
    expect(apply('# A\n', true)).toBe('---\nwidth: wide\n---\n# A\n')
    expect(apply('', true)).toBe('---\nwidth: wide\n---\n')
  })

  it('adds the key to an existing block', () => {
    expect(apply('---\ntitle: T\ntags: a\n---\n# A', true)).toBe('---\ntitle: T\ntags: a\nwidth: wide\n---\n# A')
    expect(apply('---\ntitle: T\n...\nbody', true)).toBe('---\ntitle: T\nwidth: wide\n...\nbody')
  })

  it('replaces an existing value', () => {
    expect(apply('---\nwidth: normal\ntitle: T\n---\n', true)).toBe('---\nwidth: wide\ntitle: T\n---\n')
  })

  it('removes only the width line', () => {
    expect(apply('---\ntitle: T\nwidth: wide\n# c\ntags: a\n---\n# A', false)).toBe('---\ntitle: T\n# c\ntags: a\n---\n# A')
  })

  it('removes a block that becomes empty', () => {
    expect(apply('---\nwidth: wide\n---\n# A', false)).toBe('# A')
    expect(apply('---\nwidth: wide\n---', false)).toBe('')
  })

  it('does nothing when the state already matches', () => {
    expect(widthEdit('# A', false)).toBeNull()
    expect(widthEdit('---\nwidth: wide\n---\n', true)).toBeNull()
  })
})
