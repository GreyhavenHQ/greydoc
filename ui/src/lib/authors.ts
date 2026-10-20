export type Source = 'human' | 'ai_assisted' | 'agent' | 'restore' | 'system'

export interface NoteClient {
  client_id: number
  user_id: string
  display_name: string
  source: Source
}

// Muted tones for the warm greys of the UI. White text MUST keep 4.5:1 contrast on each.
export const palette = ['#b8522a', '#4f6d8a', '#5d7d5a', '#86689a', '#a8505f', '#8a6d24', '#3f7f7a', '#66639a', '#7a5c3e', '#5f5f5a']

// Local mode shares one server user, so the name tells people apart there.
export function personSeed(id: string | undefined, name: string, local: boolean): string {
  return local || !id ? name : id
}

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
