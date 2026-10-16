import { describe, expect, it } from 'vitest'
import { applyMention, mentionLink, mentionQuery, nextPicker, splitMentions } from '@/lib/mentions'

describe('mentions', () => {
  it('writes a link with the display name and the username', () => {
    expect(mentionLink({ username: 'alice', display_name: 'Alice Martin' })).toBe('[@Alice Martin](@alice)')
    expect(mentionLink({ username: 'bob', display_name: '' })).toBe('[@bob](@bob)')
    expect(mentionLink({ username: 'x', display_name: 'A [b]\nc' })).toBe('[@A b c](@x)')
  })
  it('finds the @ query before the caret', () => {
    expect(mentionQuery('hi @ali', 7)).toEqual({ from: 3, query: 'ali' })
    expect(mentionQuery('@', 1)).toEqual({ from: 0, query: '' })
    expect(mentionQuery('mail a@b', 8)).toBeNull()
    expect(mentionQuery('hi @al ice', 10)).toBeNull()
  })
  it('replaces the query with the link', () => {
    expect(applyMention('hi @ali!', 3, 7, { username: 'alice', display_name: 'Alice' })).toEqual({ text: 'hi [@Alice](@alice) !', caret: 20 })
  })
  it('stays closed after Esc until a new @ is typed', () => {
    let p = nextPicker(null, 'hi @al', 6)
    expect(p).toEqual({ from: 3, query: 'al', dismissed: false })
    p = { ...p!, dismissed: true }
    p = nextPicker(p, 'hi @ali', 7)
    expect(p?.dismissed).toBe(true)
    p = nextPicker(p, 'hi @ali @b', 10)
    expect(p).toEqual({ from: 8, query: 'b', dismissed: false })
    expect(nextPicker(p, 'hi @ali @b ', 11)).toBeNull()
  })
  it('splits text into plain parts and mentions', () => {
    expect(splitMentions('to [@Alice](@alice), \\[@x](@y) `[@B](@bob)` ok')).toEqual([
      'to ',
      { label: 'Alice', username: 'alice' },
      ', \\[@x](@y) `[@B](@bob)` ok',
    ])
  })
})
