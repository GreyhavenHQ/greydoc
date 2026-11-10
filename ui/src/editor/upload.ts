import { EditorView } from '@codemirror/view'
import { toast } from 'sonner'

// uploadFiles sends files to the note's media endpoint and inserts Markdown links at pos.
export async function uploadFiles(view: EditorView, alias: string, files: File[], pos: number) {
  for (const file of files) {
    const id = toast.loading(`Uploading ${file.name}`)
    try {
      const form = new FormData()
      form.append('file', file)
      const resp = await fetch(`/api/notes/${alias}/media`, { method: 'POST', body: form, credentials: 'same-origin' })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data?.error?.message ?? `HTTP ${resp.status}`)
      const isImage = file.type.startsWith('image/')
      const label = file.name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '')
      const md = (isImage ? '!' : '') + `[${label}](${data.url})`
      view.dispatch({ changes: { from: pos, insert: md }, selection: { anchor: pos + md.length }, userEvent: 'input.paste' })
      pos += md.length
      toast.success('Uploaded', { id })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), { id })
    }
  }
}

// imageUpload uploads pasted or dropped files.
export function imageUpload(alias: () => string, canWrite: () => boolean) {
  const send = (view: EditorView, files: File[], pos: number) => uploadFiles(view, alias(), files, pos)
  return EditorView.domEventHandlers({
    paste(e, view) {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (!files.length || !canWrite()) return false
      e.preventDefault()
      void send(view, files, view.state.selection.main.head)
      return true
    },
    drop(e, view) {
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (!files.length || !canWrite()) return false
      e.preventDefault()
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head
      void send(view, files, pos)
      return true
    },
  })
}
