import { send, type Note } from '@/lib/api'

export interface Imported {
  file: string
  note?: Note & { renamed?: boolean; uploads?: number }
  error?: string
}

// isImportable accepts greydoc zip bundles and plain Markdown files.
export function isImportable(name: string): boolean {
  return /\.(zip|md|markdown)$/i.test(name)
}

// importFiles imports each file as a new note: a zip as a bundle with its uploads, Markdown as text.
export async function importFiles(files: File[]): Promise<Imported[]> {
  const out: Imported[] = []
  for (const f of files) {
    try {
      if (/\.zip$/i.test(f.name)) {
        const form = new FormData()
        form.append('file', f)
        out.push({ file: f.name, note: await send('/api/notes/import', form) })
      } else {
        out.push({ file: f.name, note: await send('/api/notes', await f.text(), 'text/markdown') })
      }
    } catch (e) {
      out.push({ file: f.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}
