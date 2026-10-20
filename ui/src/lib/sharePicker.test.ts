import { describe, expect, it } from 'vitest'
import { moveIndex, shareCandidates } from '@/lib/sharePicker'

const user = (username: string) => ({ id: 'id-' + username, username, display_name: '' })
const group = (id: string) => ({ id, name: id.toUpperCase() })

describe('share picker candidates', () => {
  it('lists users first, then groups', () => {
    const c = shareCandidates({ users: [user('devon')], groups: [group('dev'), group('ops')] }, { groupIds: [] })
    expect(c.map((x) => [x.kind, x.key])).toEqual([
      ['user', 'devon'],
      ['group', 'dev'],
      ['group', 'ops'],
    ])
  })
  it('leaves out the owner and the groups that already have access', () => {
    const c = shareCandidates({ users: [user('owner'), user('ana')], groups: [group('dev'), group('ops')] }, { ownerId: 'id-owner', groupIds: ['dev'] })
    expect(c.map((x) => x.key)).toEqual(['ana', 'ops'])
  })
  it('is empty when nothing matches', () => {
    expect(shareCandidates({ users: [], groups: [] }, { groupIds: [] })).toEqual([])
  })
})

describe('share picker index', () => {
  it('wraps in both directions', () => {
    expect(moveIndex(2, 1, 3)).toBe(0)
    expect(moveIndex(0, -1, 3)).toBe(2)
    expect(moveIndex(0, 1, 3)).toBe(1)
  })
  it('stays at 0 for an empty list', () => {
    expect(moveIndex(0, 1, 0)).toBe(0)
    expect(moveIndex(0, -1, 0)).toBe(0)
  })
})
