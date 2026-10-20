import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PersonAvatar } from './PersonAvatar'

const html = (seed: string, name: string) => renderToStaticMarkup(<PersonAvatar seed={seed} name={name} />)

describe('PersonAvatar', () => {
  it('renders the marble, the initials and the name as title', () => {
    const out = html('u1', 'Ada Lovelace')
    expect(out).toContain('<svg')
    expect(out).toContain('>AL<')
    expect(out).toContain('title="Ada Lovelace"')
    expect(out).toContain('data-testid="person-avatar"')
  })
  it('does not show the seed', () => {
    expect(html('secret-uid', 'Ada')).not.toContain('secret-uid')
  })
  it('gives the same svg for the same seed', () => {
    const svg = (s: string) => html(s, 'X').replace(/id="[^"]*"|url\(#[^)]*\)/g, '')
    expect(svg('u1')).toBe(svg('u1'))
    expect(svg('u1')).not.toBe(svg('u2'))
  })
})
