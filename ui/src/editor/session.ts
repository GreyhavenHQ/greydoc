import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import * as decoding from 'lib0/decoding'
import type { Level } from '@/lib/api'

// Server events sent as y-websocket message type 100 (see internal/collab/protocol.go).
export interface AppEvent {
  type: string
  level?: Level
  [key: string]: unknown
}

const APP_MESSAGE = 100

// The server closes with 44xx when the note cannot be opened: 4401 sign in, 4403 no access, 4404 missing, 4410 in the trash.
// Retrying is pointless then, and failed retries make Firefox slow down every connection to the server.
export const isRefusal = (code: number) => code >= 4400 && code < 4500

export class NoteSession {
  readonly doc = new Y.Doc()
  readonly text = this.doc.getText('content')
  readonly provider: WebsocketProvider
  private listeners = new Set<(e: AppEvent) => void>()
  // attempts counts connection tries, for the slow-load report.
  attempts = 0
  lastClose = 0

  constructor(alias: string, opts: { name?: string; share?: string | null }) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const params: Record<string, string> = {}
    if (opts.name) params.name = opts.name
    if (opts.share) params.share = opts.share
    this.provider = new WebsocketProvider(`${proto}://${location.host}/ws`, alias, this.doc, {
      params,
      shouldReconnect: (ev: CloseEvent) => !isRefusal(ev.code),
    })
    this.provider.on('status', (e: { status: string }) => {
      if (e.status === 'connecting') this.attempts++
    })
    this.provider.on('connection-close', (ev: CloseEvent | null) => {
      if (ev) this.lastClose = ev.code
    })
    this.provider.on('closed', (ev: { code: number; reason: string }) => {
      if (isRefusal(ev.code)) this.listeners.forEach((l) => l({ type: 'refused', code: ev.code, reason: ev.reason }))
    })
    this.provider.messageHandlers[APP_MESSAGE] = (_encoder, decoder) => {
      const payload = decoding.readVarUint8Array(decoder)
      const ev = JSON.parse(new TextDecoder().decode(payload)) as AppEvent
      if (ev.type === 'deleted' || (ev.type === 'access' && ev.level === 'deny')) {
        this.provider.shouldConnect = false
      }
      this.listeners.forEach((l) => l(ev))
    }
  }

  onEvent(fn: (e: AppEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setUser(user: { name: string; color: string }) {
    this.provider.awareness.setLocalStateField('user', { ...user, colorLight: user.color + '33' })
  }

  destroy() {
    this.listeners.clear()
    this.provider.destroy()
    this.doc.destroy()
  }
}
