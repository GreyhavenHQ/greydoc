import { describe, expect, it } from 'vitest'
import { isSlides } from './meta'

describe('isSlides', () => {
  it('reads type: slide from the front matter', () => {
    expect(isSlides('---\ntype: slide\n---\n# Deck')).toBe(true)
    expect(isSlides('---\ntype: Slides\n---\n')).toBe(true)
    expect(isSlides('---\ntype: note\n---\n')).toBe(false)
    expect(isSlides('type: slide')).toBe(false)
  })
})
