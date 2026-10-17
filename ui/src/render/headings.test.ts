import { describe, expect, it } from 'vitest'
import { findHeading } from '@/render/headings'

function page(html: string): HTMLElement {
  const root = document.createElement('article')
  root.innerHTML = html
  return root
}

describe('findHeading', () => {
  const root = page('<h2 id="release-plan">Release plan</h2><h2 id="été">Été</h2><p id="note">x</p>')
  it('finds the exact id', () => {
    expect(findHeading(root, '#release-plan')?.textContent).toBe('Release plan')
  })
  it('falls back to a heading with the same id in another case', () => {
    expect(findHeading(root, '#Release-Plan')?.id).toBe('release-plan')
  })
  it('decodes the hash', () => {
    expect(findHeading(root, '#%C3%A9t%C3%A9')?.id).toBe('été')
  })
  it('returns any element with the exact id', () => {
    expect(findHeading(root, '#note')?.tagName).toBe('P')
  })
  it('returns null when nothing matches', () => {
    expect(findHeading(root, '#nothing')).toBeNull()
    expect(findHeading(root, '')).toBeNull()
    expect(findHeading(root, '#%E0%A4%A')).toBeNull()
  })
})
