import { EditorState, StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { sourceLabel, type Source } from '@/lib/authors'
import { renderMarkdown } from '@/render/markdown'
import { hydrateMermaid } from '@/render/mermaid'

export interface SuggestionRange {
  id: string
  from: number
  to: number
  proposed: string
  author: string
  source: Source
  stale: boolean
  canDecide: boolean
  canWithdraw: boolean
}

export type SuggestionAction = 'accept' | 'reject' | 'focus' | 'revise'

export const setSuggestionRanges = StateEffect.define<SuggestionRange[]>()

type Act = (id: string, a: SuggestionAction, instruction?: string) => void

// PreviewWidget shows a multi-line proposal rendered, under the text it changes, so a diagram is seen as a diagram.
class PreviewWidget extends WidgetType {
  constructor(
    readonly s: SuggestionRange,
    readonly onAction: Act,
  ) {
    super()
  }
  eq(o: PreviewWidget) {
    const a = this.s
    const b = o.s
    return a.id === b.id && a.proposed === b.proposed && a.stale === b.stale && a.canDecide === b.canDecide
  }
  toDOM() {
    const card = document.createElement('div')
    card.className = 'cm-sugg-card cm-sugg-card-' + this.s.source + (this.s.stale ? ' cm-sugg-stale' : '')
    card.dataset.suggestion = this.s.id
    card.setAttribute('data-testid', 'suggestion-card')
    const head = document.createElement('div')
    head.className = 'cm-sugg-card-head'
    const label = this.s.source === 'ai_assisted' ? '✦ AI suggestion' : this.s.source === 'agent' ? '⚙ Agent suggestion' : 'Suggestion'
    head.textContent = `${label} · ${this.s.author}${this.s.stale ? ' · text changed since' : ''}`
    card.appendChild(head)
    const body = document.createElement('div')
    body.className = 'cm-sugg-card-body markdown-body'
    body.innerHTML = renderMarkdown(this.s.proposed.trim()).html
    void hydrateMermaid(body, { interactive: false, natural: true })
    card.appendChild(body)
    const foot = document.createElement('div')
    foot.className = 'cm-sugg-card-foot'
    const button = (text: string, act: SuggestionAction, primary = false) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = text
      b.className = 'cm-sugg-card-btn' + (primary ? ' is-primary' : '')
      b.onclick = () => this.onAction(this.s.id, act)
      foot.appendChild(b)
    }
    if (this.s.source === 'ai_assisted') {
      const form = document.createElement('form')
      form.className = 'cm-sugg-card-revise'
      const input = document.createElement('input')
      input.placeholder = 'Ask the AI to change it…'
      input.setAttribute('aria-label', 'Ask the AI to change the suggestion')
      form.appendChild(input)
      form.onsubmit = (e) => {
        e.preventDefault()
        if (!input.value.trim()) return
        form.classList.add('is-busy')
        input.disabled = true
        this.onAction(this.s.id, 'revise', input.value.trim())
      }
      foot.appendChild(form)
    }
    if (this.s.canDecide || this.s.canWithdraw) button(this.s.canDecide ? 'Reject' : 'Withdraw', 'reject')
    if (this.s.canDecide) button('Accept', 'accept', true)
    card.appendChild(foot)
    return card
  }
  ignoreEvent() {
    return true
  }
}

class ProposedWidget extends WidgetType {
  constructor(
    readonly s: SuggestionRange,
    readonly onAction: Act,
  ) {
    super()
  }
  eq(o: ProposedWidget) {
    const a = this.s
    const b = o.s
    return a.id === b.id && a.proposed === b.proposed && a.stale === b.stale && a.canDecide === b.canDecide
  }
  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-sugg-ins' + (this.s.stale ? ' cm-sugg-stale' : '') + (this.s.source !== 'human' ? ' cm-sugg-' + this.s.source : '')
    wrap.dataset.suggestion = this.s.id
    wrap.title = `${this.s.author}${this.s.source !== 'human' ? ' · ' + sourceLabel[this.s.source] : ''}${this.s.stale ? ' · text changed since' : ''}`
    const text = document.createElement('span')
    text.className = 'cm-sugg-text'
    text.textContent = this.s.proposed || '∅'
    wrap.appendChild(text)
    const tag = document.createElement('span')
    tag.className = 'cm-sugg-tag'
    tag.textContent = this.s.source === 'ai_assisted' ? '✦ AI' : this.s.source === 'agent' ? '⚙ agent' : this.s.author.slice(0, 1).toUpperCase()
    wrap.appendChild(tag)
    const button = (label: string, act: SuggestionAction, cls: string) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'cm-sugg-btn ' + cls
      b.textContent = label
      b.title = act === 'accept' ? 'Accept' : 'Reject'
      b.setAttribute('aria-label', b.title + ' suggestion')
      b.onmousedown = (e) => e.preventDefault()
      b.onclick = (e) => {
        e.stopPropagation()
        this.onAction(this.s.id, act)
      }
      wrap.appendChild(b)
    }
    if (this.s.canDecide) button('✓', 'accept', 'cm-sugg-accept')
    if (this.s.canDecide || this.s.canWithdraw) button('✕', 'reject', 'cm-sugg-reject')
    wrap.onclick = () => this.onAction(this.s.id, 'focus')
    return wrap
  }
  ignoreEvent() {
    return true
  }
}

export function suggestionDecorations(onAction: Act): Extension {
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes)
      for (const e of tr.effects) {
        if (!e.is(setSuggestionRanges)) continue
        const max = tr.state.doc.length
        const items = []
        for (const s of [...e.value].sort((a, b) => a.from - b.from || a.to - b.to)) {
          if (s.to > max || s.from > s.to) continue
          if (s.from < s.to) items.push(Decoration.mark({ class: 'cm-sugg-del', attributes: { 'data-suggestion': s.id } }).range(s.from, s.to))
          if (s.proposed.trim().includes('\n')) {
            const at = tr.state.doc.lineAt(s.to).to
            items.push(Decoration.widget({ widget: new PreviewWidget(s, onAction), side: 1, block: true }).range(at))
          } else {
            items.push(Decoration.widget({ widget: new ProposedWidget(s, onAction), side: 1 }).range(s.to))
          }
        }
        deco = Decoration.set(items, true)
      }
      return deco
    },
    provide: (f) => EditorView.decorations.from(f),
  })
  return [field, suggestionTheme]
}

const suggestionTheme = EditorView.baseTheme({
  '.cm-sugg-del': { textDecoration: 'line-through', textDecorationColor: 'rgb(180 50 50 / 0.8)', backgroundColor: 'rgb(180 50 50 / 0.10)' },
  '.cm-sugg-ins': {
    backgroundColor: 'rgb(42 168 118 / 0.14)', borderBottom: '2px solid rgb(42 168 118 / 0.7)', borderRadius: '2px',
    padding: '0 1px', cursor: 'pointer', whiteSpace: 'pre-wrap',
  },
  '.cm-sugg-ai_assisted': { borderBottomStyle: 'dashed', backgroundColor: 'rgb(166 42 217 / 0.10)', borderBottomColor: 'rgb(166 42 217 / 0.6)' },
  '.cm-sugg-agent': { borderBottomStyle: 'dotted', backgroundColor: 'rgb(42 127 217 / 0.10)', borderBottomColor: 'rgb(42 127 217 / 0.6)' },
  '.cm-sugg-stale': { opacity: '0.6' },
  '.cm-sugg-tag': {
    fontFamily: 'var(--font-sans)', fontSize: '10px', fontWeight: '600', marginLeft: '4px', padding: '0 4px',
    borderRadius: '3px', backgroundColor: 'rgb(var(--muted))', color: 'rgb(var(--muted-foreground))',
  },
  '.cm-sugg-btn': {
    fontFamily: 'var(--font-sans)', fontSize: '11px', marginLeft: '3px', width: '18px', height: '16px', lineHeight: '14px',
    border: '1px solid rgb(var(--border))', borderRadius: '3px', backgroundColor: 'rgb(var(--card))', cursor: 'pointer', color: 'rgb(var(--foreground))',
  },
  '.cm-sugg-accept:hover': { borderColor: 'rgb(42 168 118)', color: 'rgb(42 168 118)' },
  // contain: wide content scrolls inside the card instead of widening the editor.
  '.cm-sugg-card': {
    contain: 'inline-size',
    margin: '6px 0 10px', border: '1px solid rgb(42 168 118 / 0.5)', borderLeftWidth: '3px', borderRadius: 'var(--radius)',
    backgroundColor: 'rgb(var(--card))', fontFamily: 'var(--font-sans)', whiteSpace: 'normal', overflow: 'hidden',
  },
  '.cm-sugg-card-ai_assisted': { borderColor: 'rgb(166 42 217 / 0.45)' },
  '.cm-sugg-card-agent': { borderColor: 'rgb(42 127 217 / 0.45)' },
  '.cm-sugg-card-head': { fontSize: '11px', fontWeight: '600', padding: '6px 12px', color: 'rgb(var(--muted-foreground))', borderBottom: '1px solid rgb(var(--border) / 0.6)' },
  '.cm-sugg-card-body': { padding: '10px 12px', fontSize: '14px', maxHeight: '480px', overflow: 'auto' },
  '.cm-sugg-card-body .mermaid-block svg': { margin: '0 auto', display: 'block' },
  '.cm-sugg-card-foot': { display: 'flex', gap: '6px', padding: '6px 8px', borderTop: '1px solid rgb(var(--border) / 0.6)', alignItems: 'center' },
  '.cm-sugg-card-revise': { flex: '1' },
  '.cm-sugg-card-revise input': {
    width: '100%', font: 'inherit', fontSize: '13px', padding: '4px 8px', border: '1px solid rgb(var(--border))', borderRadius: '6px',
    backgroundColor: 'rgb(var(--background))', color: 'rgb(var(--foreground))',
  },
  '.cm-sugg-card-revise.is-busy input': { opacity: '0.6' },
  '.cm-sugg-card-btn': {
    font: 'inherit', fontSize: '12px', fontWeight: '500', padding: '4px 10px', border: '1px solid rgb(var(--border))', borderRadius: '6px',
    backgroundColor: 'transparent', color: 'rgb(var(--foreground))', cursor: 'pointer', marginLeft: 'auto',
  },
  '.cm-sugg-card-btn + .cm-sugg-card-btn': { marginLeft: '0' },
  '.cm-sugg-card-btn.is-primary': { backgroundColor: 'rgb(var(--primary))', borderColor: 'rgb(var(--primary))', color: 'rgb(var(--primary-foreground))' },
  '.cm-sugg-reject:hover': { borderColor: 'rgb(180 50 50)', color: 'rgb(180 50 50)' },
})

export interface PendingEdit {
  from: number
  to: number
  original: string
  proposed: string
}

const userEdits = ['input', 'delete', 'paste', 'drop', 'move']

// captureEdits blocks local edits while active and reports them as one replacement of the touched range.
export function captureEdits(isActive: () => boolean, onEdit: (e: PendingEdit) => void): Extension {
  return EditorState.transactionFilter.of((tr: Transaction) => {
    if (!tr.docChanged || !isActive() || !userEdits.some((u) => tr.isUserEvent(u))) return tr
    let a0 = Infinity
    let a1 = -Infinity
    tr.changes.iterChangedRanges((fromA, toA) => {
      a0 = Math.min(a0, fromA)
      a1 = Math.max(a1, toA)
    })
    const b0 = tr.changes.mapPos(a0, -1)
    const b1 = tr.changes.mapPos(a1, 1)
    onEdit({ from: a0, to: a1, original: tr.startState.sliceDoc(a0, a1), proposed: tr.newDoc.sliceString(b0, b1) })
    return []
  })
}
