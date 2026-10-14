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

export class NoteSession {
  readonly doc = new Y.Doc()
  readonly text = this.doc.getText('content')
  readonly provider: WebsocketProvider
  private listeners = new Set<(e: AppEvent) => void>()

  constructor(alias: string, opts: { name?: string; share?: string | null }) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const params: Record<string, string> = {}
    if (opts.name) params.name = opts.name
    if (opts.share) params.share = opts.share
    this.provider = new WebsocketProvider(`${proto}://${location.host}/ws`, alias, this.doc, { params })
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
