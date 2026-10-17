import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { EditorState, type Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { Heading } from '@/render/markdown'

export interface NoteHit {
  alias: string
  title: string
}

// noteLinkSource completes [[ with notes from search. Picking one writes [[alias|Title]], so the source says which note it is.
// After [[alias# it lists the headings of that note.
export function noteLinkSource(
  search: (query: string) => Promise<NoteHit[]>,
  self: () => string,
  headings: (alias: string) => Promise<Heading[]> = async () => [],
) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const s = ctx.matchBefore(/\[\[[A-Za-z0-9_-]{1,64}#[^\]|\n]{0,64}$/)
    if (s) {
      const alias = s.text.slice(2, s.text.indexOf('#')).toLowerCase()
      const list = (await headings(alias)).filter((h) => h.id)
      if (ctx.aborted || !list.length) return null
      return {
        from: s.from + s.text.indexOf('#') + 1,
        options: list.map((h) => ({
          label: h.text || h.id,
          detail: h.id,
          type: 'text',
          apply: (view: EditorView, _c: unknown, _from: number, to: number) => insertLink(view, s.from + 2, to, headingLink(alias, h)),
        })),
      }
    }
    const m = ctx.matchBefore(/\[\[[^\]|#\n]{0,64}$/)
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
        apply: (view: EditorView, _c: unknown, from: number, to: number) => insertLink(view, from, to, noteLink(n)),
      })),
    }
  }
}

// insertLink writes link without its opening [[ over from..to.
function insertLink(view: EditorView, from: number, to: number, link: string) {
  // Closing brackets may already follow, from bracket auto-closing.
  const after = view.state.sliceDoc(to, to + 2)
  const end = to + (after === ']]' ? 2 : after.startsWith(']') ? 1 : 0)
  const insert = link.slice(2)
  view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length } })
}

// noteLink is the [[alias|Title]] text for a note. ] and | would end the link, so the title drops them.
export function noteLink(n: NoteHit): string {
  const label = clean(n.title || '')
  return label && label !== n.alias ? `[[${n.alias}|${label}]]` : `[[${n.alias}]]`
}

// headingLink is the [[alias#id|Heading]] text for a heading of a note.
export function headingLink(alias: string, h: Pick<Heading, 'id' | 'text'>): string {
  const label = clean(h.text)
  return label ? `[[${alias}#${h.id}|${label}]]` : `[[${alias}#${h.id}]]`
}

function clean(s: string): string {
  return s.replace(/[\]|\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function noteLinkCompletion(
  search: (query: string) => Promise<NoteHit[]>,
  self: () => string,
  headings?: (alias: string) => Promise<Heading[]>,
): Extension {
  // CodeMirror tracks a source by identity, so it is made once. A new one per call restarts every query.
  const data = [{ autocomplete: noteLinkSource(search, self, headings) }]
  return EditorState.languageData.of(() => data)
}
