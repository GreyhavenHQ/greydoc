import { describe, expect, it } from 'vitest'
import { initials, palette, personColor, personSeed } from './authors'

describe('personSeed', () => {
  it('uses the user id when known', () => {
    expect(personSeed('u1', 'Ada', false)).toBe('u1')
  })
  it('falls back to the name without an id', () => {
    expect(personSeed('', 'Ada', false)).toBe('Ada')
    expect(personSeed(undefined, 'Ada', false)).toBe('Ada')
  })
  it('uses the name in local mode', () => {
    expect(personSeed('local', 'Ada', true)).toBe('Ada')
  })
})

describe('initials', () => {
  it('takes the first letters of two words', () => {
    expect(initials('Ada Lovelace')).toBe('AL')
    expect(initials('  grace  brewster hopper ')).toBe('GB')
  })
  it('takes one letter for one word', () => {
    expect(initials('ada')).toBe('A')
  })
  it('shows a question mark for no name', () => {
    expect(initials('')).toBe('?')
  })
})

describe('personColor', () => {
  const seeds = Array.from({ length: 20 }, (_, i) => `seed-${i}-${'x'.repeat(i)}`)
  it('is stable', () => {
    for (const s of seeds) expect(personColor(s)).toBe(personColor(s))
  })
  it('spreads seeds over several colors', () => {
    expect(new Set(seeds.map(personColor)).size).toBeGreaterThan(5)
  })
})

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('palette', () => {
  it('keeps white initials at 4.5:1 contrast or more', () => {
    for (const c of palette) expect(1.05 / (luminance(c) + 0.05)).toBeGreaterThanOrEqual(4.5)
  })
})
