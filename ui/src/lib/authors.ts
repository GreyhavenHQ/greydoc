export type Source = 'human' | 'ai_assisted' | 'agent' | 'restore' | 'system'

export interface NoteClient {
  client_id: number
  user_id: string
  display_name: string
  source: Source
}

export const palette = ['#d95e2a', '#2a7fd9', '#2aa876', '#a62ad9', '#d92a6b', '#b08800', '#00a3a3', '#6b6bd9', '#7a5c3e', '#c0392b']

// Local mode shares one server user, so the name tells people apart there.
export function personSeed(id: string | undefined, name: string, local: boolean): string {
  return local || !id ? name : id
}

// Same hash as boring-avatars, which does not export it.
function hash(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function personColor(seed: string): string {
  return palette[hash(seed) % palette.length]
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('')
}

export const sourceLabel: Record<Source, string> = {
  human: '',
  ai_assisted: 'AI-assisted',
  agent: 'Agent',
  restore: 'Restored',
  system: 'System',
}
