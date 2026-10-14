import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

export interface ThreadRange {
  id: string
  from: number
  to: number
  active: boolean
  kind: 'comment'
}

export const setThreadRanges = StateEffect.define<ThreadRange[]>()

export const threadField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setThreadRanges)) continue
      const max = tr.state.doc.length
      const ranges = e.value
        .filter((r) => r.from < r.to && r.to <= max)
        .sort((a, b) => a.from - b.from)
        .map((r) =>
          Decoration.mark({
            class: 'cm-thread' + (r.active ? ' cm-thread-active' : ''),
            attributes: { 'data-thread': r.id },
          }).range(r.from, r.to),
        )
      deco = Decoration.set(ranges, true)
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

export function threadDecorations(onClick: (id: string) => void): Extension {
  return [
    threadField,
    EditorView.domEventHandlers({
      click: (e) => {
        const el = (e.target as HTMLElement).closest('[data-thread]') as HTMLElement | null
        if (el?.dataset.thread) onClick(el.dataset.thread)
        return false
      },
    }),
    EditorView.baseTheme({
      '.cm-thread': { backgroundColor: 'rgb(234 179 8 / 0.22)', borderBottom: '2px solid rgb(234 179 8 / 0.7)', cursor: 'pointer' },
      '.cm-thread-active': { backgroundColor: 'rgb(234 179 8 / 0.42)' },
    }),
  ]
}
