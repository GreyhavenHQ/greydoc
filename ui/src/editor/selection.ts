import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'

export interface SelectionInfo {
  from: number
  to: number
  text: string
  // top and left for a toolbar above the selection, relative to the editor.
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
          const start = view.coordsAtPos(sel.from)
          const end = view.coordsAtPos(sel.to) ?? start
          if (!start || !end) return cb(null)
          const host = view.dom.getBoundingClientRect()
          // Above the selection, like most editors. Below it when there is no room at the top.
          const above = start.top - host.top - 44
          cb({
            from: sel.from,
            to: sel.to,
            text: view.state.sliceDoc(sel.from, sel.to),
            top: above > 4 ? above : end.bottom - host.top + 6,
            left: Math.max(4, Math.min(start.left - host.left, host.width - 300)),
          })
        })
      }
      destroy() {
        cancelAnimationFrame(this.frame)
      }
    },
  )
}
