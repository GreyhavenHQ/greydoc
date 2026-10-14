import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, hoverTooltip, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import * as Y from 'yjs'
import { authorColor, sourceLabel, type NoteClient } from '@/lib/authors'

export interface AuthorRun {
  from: number
  to: number
  client: number
}

// textRuns walks the Y.Text items and returns the visible ranges per Yjs client ID, in UTF-16 offsets.
export function textRuns(ytext: Y.Text): AuthorRun[] {
  const runs: AuthorRun[] = []
  let pos = 0
  let item = (ytext as unknown as { _start: Y.Item | null })._start
  while (item) {
    if (!item.deleted && item.countable && item.content instanceof Y.ContentString) {
      const len = item.length
      const last = runs[runs.length - 1]
      if (last && last.client === item.id.client && last.to === pos) last.to += len
      else runs.push({ from: pos, to: pos + len, client: item.id.client })
      pos += len
    }
    item = item.right
  }
  return runs
}

export const setClients = StateEffect.define<Map<number, NoteClient>>()

const clientsField = StateField.define<Map<number, NoteClient>>({
  create: () => new Map(),
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(setClients)) return e.value
    return v
  },
})

function authorKey(c: NoteClient | undefined, client: number) {
  return c ? c.user_id || c.display_name : 'unknown-' + client
}

function build(view: EditorView, ytext: Y.Text): DecorationSet {
  const clients = view.state.field(clientsField)
  const b = new RangeSetBuilder<Decoration>()
  const max = view.state.doc.length
  for (const r of textRuns(ytext)) {
    if (r.from >= max) break
    const c = clients.get(r.client)
    const color = authorColor(authorKey(c, r.client))
    const cls = 'cm-author' + (c?.source === 'ai_assisted' ? ' cm-author-ai' : c?.source === 'agent' ? ' cm-author-agent' : '')
    b.add(r.from, Math.min(r.to, max), Decoration.mark({ class: cls, attributes: { style: `--author:${color}` } }))
  }
  return b.finish()
}

export function attribution(ytext: Y.Text, onUnknown: () => void): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view, ytext)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setClients)))) {
          this.decorations = build(u.view, ytext)
          const clients = u.state.field(clientsField)
          if (textRuns(ytext).some((r) => !clients.has(r.client))) onUnknown()
        }
      }
    },
    { decorations: (v) => v.decorations },
  )
  const tooltip = hoverTooltip((view, pos) => {
    const run = textRuns(ytext).find((r) => r.from <= pos && pos < r.to)
    if (!run) return null
    const c = view.state.field(clientsField).get(run.client)
    return {
      pos: run.from,
      end: run.to,
      above: true,
      create: () => {
        const dom = document.createElement('div')
        dom.className = 'cm-author-tip'
        const label = c ? sourceLabel[c.source] : ''
        dom.textContent = (c?.display_name || 'Unknown author') + (label ? ` · ${label}` : '')
        return { dom }
      },
    }
  })
  return [clientsField, plugin, tooltip, attributionTheme]
}

const attributionTheme = EditorView.baseTheme({
  '.cm-author': { backgroundColor: 'color-mix(in srgb, var(--author) 14%, transparent)', borderBottom: '2px solid color-mix(in srgb, var(--author) 55%, transparent)' },
  '.cm-author-ai': { borderBottomStyle: 'dashed', backgroundImage: 'linear-gradient(90deg, color-mix(in srgb, var(--author) 10%, transparent), color-mix(in srgb, #a62ad9 12%, transparent))' },
  '.cm-author-agent': { borderBottomStyle: 'dotted' },
  '.cm-author-tip': { padding: '2px 8px', fontFamily: 'var(--font-sans)', fontSize: '12px' },
})
