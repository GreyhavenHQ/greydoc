import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { EditorState, type Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export interface NoteHit {
  alias: string
  title: string
}

// noteLinkSource completes [[ with notes from search. Picking one writes [[alias|Title]], so the source says which note it is.
export function noteLinkSource(search: (query: string) => Promise<NoteHit[]>, self: () => string) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const m = ctx.matchBefore(/\[\[[^\]|\n]{0,64}$/)
    if (!m) return null
    const notes = (await search(m.text.slice(2))).filter((n) => n.alias !== self()).slice(0, 20)
    if (ctx.aborted || !notes.length) return null
    return {
      from: m.from + 2,
      filter: false,
      options: notes.map((n) => ({
        label: n.title || n.alias,
        detail: n.alias,
        type: 'text',
        apply: (view: EditorView, _c: unknown, from: number, to: number) => {
          // Closing brackets may already follow, from bracket auto-closing.
          const after = view.state.sliceDoc(to, to + 2)
          const end = to + (after === ']]' ? 2 : after.startsWith(']') ? 1 : 0)
          const insert = noteLink(n).slice(2)
          view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length } })
        },
      })),
    }
  }
}

// noteLink is the [[alias|Title]] text for a note. ] and | would end the link, so the title drops them.
export function noteLink(n: NoteHit): string {
  const label = (n.title || '').replace(/[\]|\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  return label && label !== n.alias ? `[[${n.alias}|${label}]]` : `[[${n.alias}]]`
}

export function noteLinkCompletion(search: (query: string) => Promise<NoteHit[]>, self: () => string): Extension {
  // CodeMirror tracks a source by identity, so it is made once. A new one per call restarts every query.
  const data = [{ autocomplete: noteLinkSource(search, self) }]
  return EditorState.languageData.of(() => data)
}
