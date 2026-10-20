import type { Level } from '@/lib/api'

// AccessChange is one line of a move's dry run: how a person's or group's access to an item changes.
export interface AccessChange {
  item: string
  who: string
  kind: 'user' | 'group'
  before: Level
  after: Level
}

export interface ChangeLine {
  who: string
  before: Level
  after: Level
  items: string[]
}

export const whoLabel = (kind: 'user' | 'group', who: string) =>
  kind === 'user' ? who : who === '_everyone' ? 'Anyone with the address' : who === '_signed_in' ? 'Signed-in users' : `Group ${who}`

// summarizeChanges groups a dry run by person and change, losses first, so a long batch reads as a few lines.
export function summarizeChanges(changes: AccessChange[]): { lost: ChangeLine[]; gained: ChangeLine[] } {
  const rank: Record<Level, number> = { deny: 0, read: 1, comment: 2, write: 3, full: 4 }
  const lines = new Map<string, ChangeLine>()
  for (const c of changes) {
    const who = whoLabel(c.kind, c.who)
    const key = `${who}\u0000${c.before}\u0000${c.after}`
    const line = lines.get(key) ?? { who, before: c.before, after: c.after, items: [] }
    if (!line.items.includes(c.item)) line.items.push(c.item)
    lines.set(key, line)
  }
  const all = [...lines.values()].sort((a, b) => a.who.localeCompare(b.who))
  return { lost: all.filter((l) => rank[l.after] < rank[l.before]), gained: all.filter((l) => rank[l.after] > rank[l.before]) }
}

// Selection keys tell notes and folders apart: n:<alias> and f:<id>.
export const noteKey = (alias: string) => 'n:' + alias
export const folderKey = (id: string) => 'f:' + id

export function splitSelection(keys: Iterable<string>): { notes: string[]; folders: string[] } {
  const notes: string[] = []
  const folders: string[] = []
  for (const k of keys) {
    if (k.startsWith('n:')) notes.push(k.slice(2))
    else if (k.startsWith('f:')) folders.push(k.slice(2))
  }
  return { notes, folders }
}
