import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, type Note } from '@/lib/api'
import { loginHref } from '@/lib/me'
import { Spinner } from '@/components/ui/spinner'

// /new creates an empty note and opens it. ?alias= picks the name.
export default function NewNote() {
  const navigate = useNavigate()
  const started = useRef(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (started.current) return
    started.current = true
    const alias = new URLSearchParams(location.search).get('alias') ?? undefined
    api
      .post<Note>('/api/notes', { content: '', alias })
      .then((n) => navigate('/n/' + n.alias, { replace: true, state: { fresh: true } }))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          location.href = loginHref('/new')
          return
        }
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [navigate])
  return (
    <div className="flex h-screen items-center justify-center text-muted-foreground">
      {error ? <p className="text-destructive">{error}</p> : <Spinner />}
    </div>
  )
}
