import { describe as suite, expect, it } from 'vitest'
import { describe, type AuditEvent } from '@/lib/events'

const ev = (kind: string, data: Record<string, unknown>): AuditEvent => ({ id: '1', actor_name: 'greydoc', source: 'human', kind, data, created_at: '' })

suite('event text', () => {
  it('explains a removed group grant', () => {
    expect(describe(ev('permission.group_removed', { group: 'eng', level: 'write' }))).toBe(
      'removed edit access for group eng: documents are shared with people only',
    )
  })
  it('keeps old group grants readable', () => {
    expect(describe(ev('permission.group', { group: 'eng', level: 'read' }))).toBe('gave group eng view access')
  })
  it('shows a slug change with the previous address', () => {
    expect(describe(ev('alias.change', { alias: 'roadmap-2027', previous: 'team-roadmap' }))).toBe(
      'changed the address from /team-roadmap to /roadmap-2027',
    )
  })
})
