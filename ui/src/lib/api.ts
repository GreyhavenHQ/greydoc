export class ApiError extends Error {
  code: string
  status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  return parse<T>(resp)
}

// send posts a raw body: FormData sets its own content type, a string or Blob takes the one given.
export async function send<T>(path: string, body: FormData | Blob | string, contentType?: string): Promise<T> {
  const resp = await fetch(path, { method: 'POST', headers: contentType ? { 'Content-Type': contentType } : undefined, body, credentials: 'same-origin' })
  return parse<T>(resp)
}

async function parse<T>(resp: Response): Promise<T> {
  const text = await resp.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!resp.ok) {
    const err = (data as { error?: { message?: string; code?: string } } | null)?.error
    throw new ApiError(err?.message ?? `HTTP ${resp.status}`, err?.code ?? 'http_error', resp.status)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}

export type Level = 'deny' | 'read' | 'comment' | 'write' | 'full'

export const levelRank: Record<Level, number> = { deny: 0, read: 1, comment: 2, write: 3, full: 4 }

export const atLeast = (l: Level | undefined, need: Level) => !!l && levelRank[l] >= levelRank[need]

export interface AiPreset {
  id: string
  label: string
  instruction: string
  output: 'replace' | 'below' | 'diagram'
}

export interface Me {
  authenticated: boolean
  local_mode: boolean
  ai_enabled: boolean
  // ai_actions are the server's AI presets, set with GREYDOC_AI_ACTIONS.
  ai_actions?: AiPreset[] | null
  login_url: string
  id?: string
  username?: string
  display_name?: string
  groups?: string[]
  admin?: boolean
}

export interface User {
  id: string
  username: string
  display_name: string
}

export interface NoteSummary {
  id: string
  alias: string
  title: string
  description: string
  tags: string[]
  owner: string
  updated_at: string
  visited_at?: string
  pinned: boolean
  snippet?: string
  view_count: number
  slides: boolean
}

export interface Note {
  id: string
  alias: string
  title: string
  description: string
  tags: string[]
  agent_policy: AgentPolicy
  view_count: number
  slides: boolean
  created_at: string
  updated_at: string
  level: Level
  content?: string
  aliases?: { name: string; primary: boolean }[]
  owner?: User
}

export type AgentPolicy = 'none' | 'read' | 'suggest' | 'edit'

export interface TagCount {
  tag: string
  count: number
}

export const noteTitle = (n: { title: string; alias: string }) => n.title || 'Untitled'

// shareParam is the view-only token: from a short /v/<token> address, or from ?share= in older links.
export function shareParam(): string | null {
  const short = /^\/v\/([^/]+)/.exec(location.pathname)
  return short ? decodeURIComponent(short[1]) : new URLSearchParams(location.search).get('share')
}

export function withShare(path: string): string {
  const share = shareParam()
  if (!share) return path
  return path + (path.includes('?') ? '&' : '?') + 'share=' + encodeURIComponent(share)
}
