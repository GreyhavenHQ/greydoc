import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { AppHeader } from '@/components/AppHeader'
import { SourceBadge } from '@/components/Timeline'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { describe, type AuditEvent } from '@/lib/events'
import { authorColor } from '@/lib/authors'
import { loginHref, useMe } from '@/lib/me'
import { relativeTime, shortDateTime } from '@/lib/time'

const kinds = [
  { id: 'all', label: 'Everything' },
  { id: 'note', label: 'Notes: create, trash, restore, delete' },
  { id: 'permission', label: 'Permissions' },
  { id: 'comment', label: 'Comments' },
  { id: 'suggestion', label: 'Suggestions' },
  { id: 'revision', label: 'Restored versions' },
  { id: 'user', label: 'Sign-ins' },
  { id: 'token', label: 'Access tokens' },
  { id: 'oauth', label: 'Connected agents' },
]

const sources = [
  { id: 'all', label: 'Anyone' },
  { id: 'human', label: 'People' },
  { id: 'ai_assisted', label: 'AI-assisted' },
  { id: 'agent', label: 'Agents' },
  { id: 'system', label: 'System' },
]

// Audit lists every recorded action across notes and accounts, newest first.
export default function Audit() {
  const { me } = useMe()
  const [params, setParams] = useSearchParams()
  const kind = params.get('kind') ?? 'all'
  const source = params.get('source') ?? 'all'
  const [actor, setActor] = useState(params.get('actor') ?? '')
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [all, setAll] = useState(false)
  const [more, setMore] = useState(false)

  const query = useCallback(
    (before?: string) => {
      const q = new URLSearchParams()
      if (kind !== 'all') q.set('kind', kind)
      if (source !== 'all') q.set('source', source)
      if (params.get('actor')) q.set('actor', params.get('actor')!)
      if (params.get('note')) q.set('note', params.get('note')!)
      if (before) q.set('before', before)
      return api.get<{ events: AuditEvent[]; all: boolean }>('/api/audit?' + q)
    },
    [kind, source, params],
  )

  const load = useCallback(() => {
    query().then((r) => {
      setEvents(r.events)
      setAll(r.all)
      setMore(r.events.length === 100)
    })
  }, [query])

  useEffect(() => {
    if (me?.authenticated) load()
  }, [me, load])

  useEffect(() => {
    const t = setTimeout(() => {
      if (actor === (params.get('actor') ?? '')) return
      const next = new URLSearchParams(params)
      if (actor) next.set('actor', actor)
      else next.delete('actor')
      setParams(next, { replace: true })
    }, 300)
    return () => clearTimeout(t)
  }, [actor, params, setParams])

  if (me && !me.authenticated) {
    location.href = loginHref()
    return null
  }

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    if (v && v !== 'all') next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }

  const restore = async (alias: string) => {
    try {
      await api.post(`/api/notes/${alias}/restore`)
      toast.success('Restored')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          {all ? 'Every recorded action on this server.' : 'Actions on notes you can read, and your own actions.'} Text edits are in each note's timeline.
        </p>
        <div className="mb-4 flex flex-wrap gap-2">
          <Select value={kind} onValueChange={(v) => set('kind', v)}>
            <SelectTrigger className="h-9 w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {kinds.map((k) => (
                <SelectItem key={k.id} value={k.id}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={source} onValueChange={(v) => set('source', v)}>
            <SelectTrigger className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sources.map((k) => (
                <SelectItem key={k.id} value={k.id}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Person" className="h-9 w-48" />
          {params.get('note') && (
            <Badge variant="secondary" className="h-9 gap-1">
              Note {params.get('note')}
              <button onClick={() => set('note', '')} aria-label="Clear note filter">
                ×
              </button>
            </Badge>
          )}
        </div>
        <ol className="flex flex-col divide-y rounded-lg border bg-card" data-testid="audit-list">
          {events.map((ev) => (
            <li key={ev.id} className="flex gap-3 px-4 py-3 text-sm" data-testid="audit-event">
              <span
                className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                style={{ backgroundColor: authorColor(ev.actor_id || ev.actor_name) }}
              >
                {(ev.actor_name || '?').slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{ev.actor_name || 'someone'}</span>
                  <span className="text-muted-foreground">{describe(ev)}</span>
                  <SourceBadge source={ev.source} />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span title={shortDateTime(ev.created_at)}>{relativeTime(ev.created_at)}</span>
                  {ev.client && <span>via {ev.client}</span>}
                  {ev.note_state === 'live' && ev.note_alias && (
                    <Link to={'/n/' + ev.note_alias} className="text-foreground underline underline-offset-2">
                      {ev.note_title || ev.note_alias}
                    </Link>
                  )}
                  {ev.note_state === 'trash' && (
                    <span className="flex items-center gap-1.5">
                      <span>{ev.note_title || ev.note_alias}</span>
                      <Badge variant="outline" className="px-1 py-0 text-[10px]">
                        in trash
                      </Badge>
                    </span>
                  )}
                  {ev.note_state === 'deleted' && (
                    <span className="flex items-center gap-1.5">
                      <span>{ev.note_title || String(ev.data?.title ?? ev.data?.alias ?? 'a note')}</span>
                      <Badge variant="outline" className="px-1 py-0 text-[10px]">
                        deleted
                      </Badge>
                    </span>
                  )}
                  {ev.note_id && ev.note_state !== 'deleted' && (
                    <button className="underline-offset-2 hover:underline" onClick={() => set('note', ev.note_alias || ev.note_id!)}>
                      only this note
                    </button>
                  )}
                </div>
              </div>
              {ev.note_state === 'trash' && ev.kind === 'note.trash' && ev.note_alias && (
                <Button size="sm" variant="outline" className="self-center" onClick={() => restore(ev.note_alias!)}>
                  <RotateCcw className="size-3.5" /> Restore
                </Button>
              )}
            </li>
          ))}
          {events.length === 0 && <li className="px-4 py-12 text-center text-muted-foreground">Nothing recorded for these filters.</li>}
        </ol>
        {more && (
          <Button
            variant="ghost"
            className="mt-3"
            onClick={() =>
              query(events[events.length - 1].created_at).then((r) => {
                setEvents([...events, ...r.events])
                setMore(r.events.length === 100)
              })
            }
          >
            Load older
          </Button>
        )}
      </main>
    </div>
  )
}
