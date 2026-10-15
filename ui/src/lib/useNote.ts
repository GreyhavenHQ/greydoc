import { useEffect, useState } from 'react'
import { api, ApiError, withShare, type Note } from '@/lib/api'

// useNote loads a note once, for pages that only show it: the view page and slide mode. They need no
// live connection. A reload shows the latest text.
export function useNote(alias: string) {
  const [note, setNote] = useState<Note | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)

  useEffect(() => {
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
  }, [alias])

  return { note, text: note?.content ?? '', error }
}
