import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState, RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { cachedName, displayNames, isSelf, mentionLink, mentionPattern, mentionQuery, type Person } from '@/lib/mentions'

// mentionSource completes @ with people. A pick writes [@Name](@username). Esc closes the list and keeps the text.
export function mentionSource(search: (query: string) => Promise<Person[]>, onNoAccess: (p: Person) => void) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const line = ctx.state.doc.lineAt(ctx.pos)
    const q = mentionQuery(line.text, ctx.pos - line.from)
    if (!q || inCode(ctx.state, ctx.pos)) return null
    const found = await search(q.query)
    if (ctx.aborted || !found.length) return null
    return {
      from: line.from + q.from,
      filter: false,
      options: found.map((p) => ({
        label: p.display_name || p.username,
        detail: '@' + p.username + (p.can_read === false ? ' · no access' : ''),
        type: 'text',
        apply: (view: EditorView, _c: unknown, from: number, to: number) => {
          const insert = mentionLink(p) + ' '
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
          if (p.can_read === false) onNoAccess(p)
        },
      })),
    }
  }
}

const codeNodes = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'HTMLBlock'])

function inCode(state: EditorState, pos: number): boolean {
  for (let n: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent as typeof n) {
    if (codeNodes.has(n.name)) return true
  }
  return false
}

export interface Chip {
  from: number
  to: number
  label: string
  username: string
}

// chipRanges lists the mentions between from and to that show as chips: outside code, and not under the cursor.
export function chipRanges(state: EditorState, from: number, to: number): Chip[] {
  const tree = ensureSyntaxTree(state, to, 50) ?? syntaxTree(state)
  const out: Chip[] = []
  for (let pos = from; pos <= to; ) {
    const line = state.doc.lineAt(pos)
    for (const m of line.text.matchAll(mentionPattern)) {
      if (m[1]) continue
      const a = line.from + m.index
      const b = a + m[0].length
      let code = false
      for (let n: { name: string; parent: unknown } | null = tree.resolveInner(a + 1, 1); n; n = n.parent as typeof n) {
        if (codeNodes.has(n.name)) code = true
      }
      if (code || state.selection.ranges.some((r) => r.from > a && r.to < b)) continue
      out.push({ from: a, to: b, label: m[2], username: m[3].toLowerCase() })
    }
    pos = line.to + 1
  }
  return out
}

class ChipWidget extends WidgetType {
  constructor(
    readonly username: string,
    readonly name: string,
  ) {
    super()
  }
  eq(o: ChipWidget) {
    return o.username === this.username && o.name === this.name
  }
  toDOM(view: EditorView) {
    const el = document.createElement('span')
    el.className = 'mention' + (isSelf(this.username) ? ' mention-self' : '')
    el.dataset.user = this.username
    el.textContent = '@' + this.name
    el.onmousedown = (e) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: view.posAtDOM(el) + 2 } })
      view.focus()
    }
    return el
  }
  ignoreEvent() {
    return false
  }
}

const namesLoaded = StateEffect.define<null>()

const chips = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    asked = new Set<string>()
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(namesLoaded)))) {
        this.decorations = this.build(u.view)
      }
    }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>()
      const missing: string[] = []
      for (const { from, to } of view.visibleRanges) {
        for (const c of chipRanges(view.state, from, to)) {
          const name = cachedName(c.username)
          if (name === undefined && !this.asked.has(c.username)) {
            this.asked.add(c.username)
            missing.push(c.username)
          }
          b.add(c.from, c.to, Decoration.replace({ widget: new ChipWidget(c.username, name ?? c.label) }))
        }
      }
      if (missing.length) void displayNames(missing).then(() => view.dispatch({ effects: namesLoaded.of(null) }))
      return b.finish()
    }
  },
  { decorations: (p) => p.decorations },
)

// mentions adds the @ picker and the chips. Backspace after a chip removes the whole mention.
export function mentions(search: (query: string) => Promise<Person[]>, onNoAccess: (p: Person) => void): Extension {
  const data = [{ autocomplete: mentionSource(search, onNoAccess) }]
  return [
    EditorState.languageData.of(() => data),
    chips,
    EditorView.atomicRanges.of((view) => view.plugin(chips)?.decorations ?? Decoration.none),
  ]
}
