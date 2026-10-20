import type { GroupRef, User } from '@/lib/api'

export type ShareCandidate = { kind: 'user'; key: string; user: User } | { kind: 'group'; key: string; group: GroupRef }

export function shareCandidates(found: { users: User[]; groups: GroupRef[] }, exclude: { ownerId?: string; groupIds: string[] }): ShareCandidate[] {
  const users: ShareCandidate[] = found.users.filter((u) => u.id !== exclude.ownerId).map((u) => ({ kind: 'user', key: u.username, user: u }))
  const groups: ShareCandidate[] = found.groups.filter((g) => !exclude.groupIds.includes(g.id)).map((g) => ({ kind: 'group', key: g.id, group: g }))
  return [...users, ...groups]
}

export function moveIndex(i: number, delta: number, length: number): number {
  if (length === 0) return 0
  return (i + delta + length) % length
}
