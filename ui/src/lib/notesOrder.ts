import { noteTitle, type NoteSummary } from '@/lib/api'

export type ListMode = 'index' | 'recent' | 'search'

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// compareIndex matches the default order of store.ListNotes. It compares code points, like SQLite LOWER.
const compareIndex = (a: NoteSummary, b: NoteSummary) =>
  Number(b.pinned) - Number(a.pinned) ||
  (a.pinned ? cmp(noteTitle(a).toLowerCase(), noteTitle(b).toLowerCase()) : 0) ||
  cmp(b.updated_at, a.updated_at) ||
  cmp(a.id, b.id)

const compareRecent = (a: NoteSummary, b: NoteSummary) => Number(b.pinned) - Number(a.pinned) || cmp(b.visited_at ?? '', a.visited_at ?? '')

// placeAfterPin moves a note to its sorted place after a pin toggle.
// A note placed after the last loaded row is dropped while more pages remain, so the next page brings it back.
export function placeAfterPin(notes: NoteSummary[], id: string, pinned: boolean, mode: ListMode, hasMore: boolean): NoteSummary[] {
  const cur = notes.find((n) => n.id === id)
  if (!cur) return notes
  const moved = { ...cur, pinned }
  if (mode === 'search') return notes.map((n) => (n.id === id ? moved : n))
  const compare = mode === 'recent' ? compareRecent : compareIndex
  const rest = notes.filter((n) => n.id !== id)
  const at = rest.findIndex((n) => compare(moved, n) < 0)
  if (at < 0) return hasMore ? rest : [...rest, moved]
  return [...rest.slice(0, at), moved, ...rest.slice(at)]
}
