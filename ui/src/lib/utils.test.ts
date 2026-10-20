import { describe, expect, it } from 'vitest'
import { handle } from './utils'

describe('handle', () => {
  it('prefixes a plain username', () => expect(handle('alice')).toBe('@alice'))
  it('keeps an email address as it is', () => expect(handle('alice@example.com')).toBe('alice@example.com'))
})
