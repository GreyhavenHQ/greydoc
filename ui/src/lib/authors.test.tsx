import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import Avatar from 'boring-avatars'
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
  it('equals the marble background', () => {
    for (const s of seeds) {
      const svg = renderToStaticMarkup(<Avatar variant="marble" name={s} colors={palette} />)
      const fill = /<g[^>]*><rect[^>]*fill="([^"]+)"/.exec(svg)?.[1]
      expect(fill).toBe(personColor(s))
    }
  })
})
