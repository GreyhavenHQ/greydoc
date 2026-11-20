import { describe, expect, it } from 'vitest'
import { escapeTyped } from '@/editor/docinput'

// typed runs escapeTyped over each character, as a person types them on a new line.
const typed = (s: string, line = '') => {
  for (const ch of s) line += escapeTyped(line, ch)
  return line
}

describe('escapeTyped', () => {
  it('stores the characters of inline marks as text', () => {
    expect(typed('5 * 3 and a_b `x` [[doc]] <b> ~x~ ^y^ $5 a|b \\ & c')).toBe(
      '5 \\* 3 and a\\_b \\`x\\` \\[\\[doc\\]\\] \\<b> \\~x\\~ \\^y\\^ \\$5 a\\|b \\\\ \\& c',
    )
  })
  it('breaks == and ++ but keeps a single = or +', () => {
    expect(typed('x = 1, a == b, c + d, e ++ f')).toBe('x = 1, a =\\= b, c + d, e +\\+ f')
  })
  it('stores the marks of a line start as text', () => {
    expect(typed('# Not a heading')).toBe('\\# Not a heading')
    expect(typed('- not a list')).toBe('\\- not a list')
    expect(typed('+ not a list')).toBe('\\+ not a list')
    expect(typed('1. not a list')).toBe('1\\. not a list')
    expect(typed('12) not a list')).toBe('12\\) not a list')
    expect(typed('> not a quote')).toBe('\\> not a quote')
    expect(typed('=====')).toBe('\\=\\=\\=\\=\\=')
    expect(typed(': not a definition')).toBe('\\: not a definition')
  })
  it('keeps those characters inside a sentence', () => {
    expect(typed('pages 1. to 3 - see # 4 > 2')).toBe('pages 1. to 3 - see # 4 > 2')
  })
  it('keeps a list or a quote made with the toolbar', () => {
    expect(typed('1. a', '- ')).toBe('- 1\\. a')
    expect(typed('> x', '> ')).toBe('> \\> x')
  })
  it('breaks an emoji code but keeps a time', () => {
    expect(typed(':smile: at 10:30')).toBe('\\:smile\\: at 10:30')
  })
})
