import { api, send, type Note } from '@/lib/api'

export interface Imported {
  file: string
  note?: Note & { renamed?: boolean; uploads?: number }
  error?: string
}

// isImportable accepts greydoc zip bundles and plain Markdown files.
export function isImportable(name: string): boolean {
  return /\.(zip|md|markdown)$/i.test(name)
}

// importFiles imports each file as a new note in folder, or at the top level: a zip as a greydoc bundle, Markdown as text.
export async function importFiles(files: File[], folder?: string): Promise<Imported[]> {
  const out: Imported[] = []
  for (const f of files) {
    try {
      if (/\.zip$/i.test(f.name)) {
        const form = new FormData()
        if (folder) form.append('folder', folder)
        form.append('require_meta', '1')
        form.append('file', f)
        out.push({ file: f.name, note: await send('/api/notes/import', form) })
      } else {
        out.push({ file: f.name, note: await api.post('/api/notes', { content: await f.text(), ...(folder ? { folder } : {}) }) })
      }
    } catch (e) {
      out.push({ file: f.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}
