import { describe, expect, it } from 'vitest'
import { markRead, notificationHref, notificationText, type Notification } from '@/lib/notifications'

const base: Notification = {
  id: 'n1',
  note_id: 'x',
  note_alias: 'plan',
  note_title: 'Plan',
  kind: 'comment',
  actor_id: 'b',
  actor_name: 'Bob',
  ref: 't1',
  created_at: '2026-01-01T00:00:00.000000Z',
}

describe('notifications', () => {
  it('opens the document at the mention', () => {
    expect(notificationHref(base)).toBe('/n/plan?thread=t1')
    expect(notificationHref({ ...base, kind: 'suggestion', ref: 's1' })).toBe('/n/plan?thread=s1')
    expect(notificationHref({ ...base, kind: 'document', ref: '' })).toBe('/n/plan?mention=1')
  })
  it('names the actor, the kind and the document', () => {
    expect(notificationText(base)).toBe('Bob mentioned you in a comment on Plan')
    expect(notificationText({ ...base, kind: 'suggestion', note_title: '' })).toBe('Bob mentioned you in a suggestion on plan')
    expect(notificationText({ ...base, kind: 'document' })).toBe('Bob mentioned you in Plan')
  })
  it('marks one or all as read', () => {
    const list = [base, { ...base, id: 'n2' }]
    const one = markRead({ list, unread: 2 }, ['n1'], 'T')
    expect(one.unread).toBe(1)
    expect(one.list.map((n) => n.read_at)).toEqual(['T', undefined])
    expect(markRead(one, ['n1'], 'U').unread).toBe(1)
    const all = markRead(one, null, 'U')
    expect(all.unread).toBe(0)
    expect(all.list.map((n) => n.read_at)).toEqual(['T', 'U'])
  })
})
