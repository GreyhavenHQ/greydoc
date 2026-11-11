import { EditorView } from '@codemirror/view'
import { toast } from 'sonner'

// uploadFile sends a file to the note's media endpoint and gives its Markdown link, or null when it fails.
export async function uploadFile(alias: string, file: File): Promise<string | null> {
  const id = toast.loading(`Uploading ${file.name}`)
  try {
    const form = new FormData()
    form.append('file', file)
    const resp = await fetch(`/api/notes/${alias}/media`, { method: 'POST', body: form, credentials: 'same-origin' })
    const data = await resp.json()
    if (!resp.ok) throw new Error(data?.error?.message ?? `HTTP ${resp.status}`)
    const isImage = file.type.startsWith('image/')
    const label = file.name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '')
    toast.success('Uploaded', { id })
    return (isImage ? '!' : '') + `[${label}](${data.url})`
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e), { id })
    return null
  }
}

// uploadFiles uploads files and inserts their Markdown links at pos.
export async function uploadFiles(view: EditorView, alias: string, files: File[], pos: number) {
  for (const file of files) {
    const md = await uploadFile(alias, file)
    if (!md) continue
    view.dispatch({ changes: { from: pos, insert: md }, selection: { anchor: pos + md.length }, userEvent: 'input.paste' })
    pos += md.length
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
