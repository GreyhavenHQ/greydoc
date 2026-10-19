import { api } from '@/lib/api'

export interface Person {
  username: string
  display_name: string
  // can_read is set when the search names a document: false means the person cannot open it.
  can_read?: boolean
}

export interface Mention {
  label: string
  username: string
}

// The source form of a mention. The server parses the same pattern in internal/notemeta/mentions.go.
export const mentionPattern = /(\\?)\[@([^\]\n]*)\]\(@([A-Za-z0-9][A-Za-z0-9._@+-]*)\)/g

export function mentionLink(p: Pick<Person, 'username' | 'display_name'>): string {
  const label = (p.display_name || p.username).replace(/[[\]\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `[@${label}](@${p.username})`
}

// mentionQuery finds an @ that starts a word right before the caret.
export function mentionQuery(text: string, caret: number): { from: number; query: string } | null {
  const m = /(^|[\s(])@([\p{L}\p{N}._-]{0,32})$/u.exec(text.slice(0, caret))
  if (!m) return null
  return { from: caret - m[2].length - 1, query: m[2] }
}

export function applyMention(text: string, from: number, caret: number, p: Person): { text: string; caret: number } {
  const insert = mentionLink(p) + ' '
  return { text: text.slice(0, from) + insert + text.slice(caret), caret: from + insert.length }
}

export interface PickerState {
  from: number
  query: string
  dismissed: boolean
}

// nextPicker follows the text. A picker closed with Esc stays closed for the same @.
export function nextPicker(prev: PickerState | null, text: string, caret: number): PickerState | null {
  const q = mentionQuery(text, caret)
  if (!q) return null
  return { ...q, dismissed: Boolean(prev?.dismissed && prev.from === q.from) }
}

// splitMentions cuts text into plain strings and mentions. Mentions in code spans stay text.
export function splitMentions(text: string): (string | Mention)[] {
  const out: (string | Mention)[] = []
  const code: [number, number][] = []
  for (const m of text.matchAll(/(`+)[\s\S]*?\1/g)) code.push([m.index, m.index + m[0].length])
  let last = 0
  for (const m of text.matchAll(mentionPattern)) {
    if (m[1] || code.some(([a, b]) => m.index >= a && m.index < b)) continue
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push({ label: m[2], username: m[3].toLowerCase() })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function searchPeople(query: string, alias?: string): Promise<Person[]> {
  const params = new URLSearchParams({ q: query })
  if (alias) params.set('note', alias)
  return api.get<{ users: Person[] }>('/api/users?' + params).then((r) => r.users)
}

const names = new Map<string, { at: number; name: Promise<string | undefined> }>()
const known = new Map<string, string>()

// displayNames returns the current names of people, cached for a minute. Unknown people are left out.
export async function displayNames(usernames: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(usernames.map((u) => u.toLowerCase()))]
  const missing = wanted.filter((u) => {
    const hit = names.get(u)
    return !hit || Date.now() - hit.at > 60_000
  })
  if (missing.length) {
    const req = api
      .get<{ names: Record<string, string> }>('/api/users/names?' + missing.map((u) => 'u=' + encodeURIComponent(u)).join('&'))
      .then((r) => {
        for (const [u, n] of Object.entries(r.names)) known.set(u, n)
        return r.names
      })
      .catch(() => ({}) as Record<string, string>)
    for (const u of missing) names.set(u, { at: Date.now(), name: req.then((r) => r[u]) })
  }
  const out = new Map<string, string>()
  for (const u of wanted) {
    const n = await names.get(u)!.name
    if (n) out.set(u, n)
  }
  return out
}

// cachedName returns a name already loaded, for code that cannot wait.
export function cachedName(username: string): string | undefined {
  return known.get(username.toLowerCase())
}

let enabled = false
let self = ''

// setMentionsOn turns mentions on for a signed-in user of a server with OIDC.
export function setMentionsOn(on: boolean, username = '') {
  enabled = on
  self = on ? username.toLowerCase() : ''
  document.documentElement.classList.toggle('mentions-on', on)
}

export const mentionsOn = () => enabled
export const isSelf = (username: string) => self !== '' && username.toLowerCase() === self
