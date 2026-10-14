export type Source = 'human' | 'ai_assisted' | 'agent' | 'restore' | 'system'

export interface NoteClient {
  client_id: number
  user_id: string
  display_name: string
  source: Source
}

const palette = ['#d95e2a', '#2a7fd9', '#2aa876', '#a62ad9', '#d92a6b', '#b08800', '#00a3a3', '#6b6bd9', '#7a5c3e', '#c0392b']

export function authorColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
  return palette[Math.abs(h) % palette.length]
}

export const sourceLabel: Record<Source, string> = {
  human: '',
  ai_assisted: 'AI-assisted',
  agent: 'Agent',
  restore: 'Restored',
  system: 'System',
}
