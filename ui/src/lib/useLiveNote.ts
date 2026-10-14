import { useEffect, useState } from 'react'
import { NoteSession } from '@/editor/session'
import { api, ApiError, shareParam, withShare, type Note } from '@/lib/api'

// useLiveNote loads a note and follows its text live, without presence: viewers stay invisible.
export function useLiveNote(alias: string) {
  const [note, setNote] = useState<Note | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const [synced, setSynced] = useState(false)

  useEffect(() => {
    let session: NoteSession | null = null
    let cancelled = false
    api
      .get<Note>(withShare(`/api/notes/${alias}`))
      .then((n) => {
        if (cancelled) return
        setNote(n)
        setText(n.content ?? '')
        session = new NoteSession(n.alias, { share: shareParam() })
        session.provider.awareness.setLocalState(null)
        const update = () => setText(session!.text.toString())
        session.text.observe(update)
        session.provider.on('sync', (v: boolean) => {
          if (v) update()
          setSynced(v)
        })
      })
      .catch((e: unknown) =>
        setError({ status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : String(e) }),
      )
    return () => {
      cancelled = true
      session?.destroy()
    }
  }, [alias])

  return { note, text, error, synced }
}
