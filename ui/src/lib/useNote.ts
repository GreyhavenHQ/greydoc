import { useEffect, useState } from 'react'
import { api, ApiError, withShare, type Note } from '@/lib/api'
import { takeBoot } from '@/lib/boot'

// useNote loads a note once, for pages that only show it: the view page and slide mode. They need no
// live connection. A reload shows the latest text. The first page can use the note that the server inlined.
export function useNote(alias: string) {
  const [first] = useState(() => {
    const b = takeBoot('note')
    return b && b.alias === alias ? { alias, note: b.data as Note } : null
  })
  const [note, setNote] = useState<Note | null>(first?.note ?? null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)

  useEffect(() => {
    if (first?.alias === alias) return
    let cancelled = false
    setNote(null)
    setError(null)
    api
      .get<Note>(withShare(`/api/notes/${alias}?visit=1`))
      .then((n) => !cancelled && setNote(n))
      .catch((e: unknown) => {
        if (!cancelled) setError({ status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [alias, first])

  return { note, text: note?.content ?? '', error }
}
