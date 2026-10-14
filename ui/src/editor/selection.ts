import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'

export interface SelectionInfo {
  from: number
  to: number
  text: string
  // top and left of the selection end, relative to the editor's scroll container.
  top: number
  left: number
}

// selectionListener reports the main selection when it is not empty.
export function selectionListener(cb: (s: SelectionInfo | null) => void) {
  return ViewPlugin.fromClass(
    class {
      frame = 0
      constructor(view: EditorView) {
        this.schedule(view)
      }
      update(u: ViewUpdate) {
        if (u.selectionSet || u.docChanged || u.geometryChanged || u.focusChanged) this.schedule(u.view)
      }
      schedule(view: EditorView) {
        cancelAnimationFrame(this.frame)
        this.frame = requestAnimationFrame(() => {
          const sel = view.state.selection.main
          if (sel.empty) return cb(null)
          const coords = view.coordsAtPos(sel.to) ?? view.coordsAtPos(sel.from)
          if (!coords) return cb(null)
          const host = view.dom.getBoundingClientRect()
          cb({
            from: sel.from,
            to: sel.to,
            text: view.state.sliceDoc(sel.from, sel.to),
            top: coords.bottom - host.top + 6,
            left: Math.min(coords.left - host.left, host.width - 260),
          })
        })
      }
      destroy() {
        cancelAnimationFrame(this.frame)
      }
    },
  )
}
