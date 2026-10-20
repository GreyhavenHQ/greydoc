import { describe, expect, it } from 'vitest'
import { splitSelection, summarizeChanges } from './folders'

describe('summarizeChanges', () => {
  it('groups the same change across items and splits losses from gains', () => {
    const r = summarizeChanges([
      { item: 'Plan', who: 'bob', kind: 'user', before: 'read', after: 'deny' },
      { item: 'Notes', who: 'bob', kind: 'user', before: 'read', after: 'deny' },
      { item: 'Plan', who: 'eng', kind: 'group', before: 'deny', after: 'write' },
      { item: 'Plan', who: '_signed_in', kind: 'group', before: 'write', after: 'read' },
    ])
    expect(r.lost).toEqual([
      { who: 'bob', before: 'read', after: 'deny', items: ['Plan', 'Notes'] },
      { who: 'Signed-in users', before: 'write', after: 'read', items: ['Plan'] },
    ])
    expect(r.gained).toEqual([{ who: 'Group eng', before: 'deny', after: 'write', items: ['Plan'] }])
  })
})

describe('splitSelection', () => {
  it('separates notes and folders', () => {
    expect(splitSelection(['n:plan', 'f:123', 'n:x'])).toEqual({ notes: ['plan', 'x'], folders: ['123'] })
  })
})
