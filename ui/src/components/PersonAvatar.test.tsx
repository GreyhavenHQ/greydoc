import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PersonAvatar } from './PersonAvatar'
import { personColor } from '@/lib/authors'

const html = (seed: string, name: string) => renderToStaticMarkup(<PersonAvatar id={seed} name={name} />)

describe('PersonAvatar', () => {
  it('renders a flat circle with the initials and the name as title', () => {
    const out = html('u1', 'Ada Lovelace')
    expect(out).not.toContain('<svg')
    expect(out).toContain(`background-color:${personColor('u1')}`)
    expect(out).toContain('>AL<')
    expect(out).toContain('title="Ada Lovelace"')
    expect(out).toContain('data-testid="person-avatar"')
  })
  it('does not show the seed', () => {
    expect(html('secret-uid', 'Ada')).not.toContain('secret-uid')
  })
  it('gives the same markup for the same seed', () => {
    expect(html('u1', 'X')).toBe(html('u1', 'X'))
  })
})
