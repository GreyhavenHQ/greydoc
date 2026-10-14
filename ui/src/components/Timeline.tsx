import { useCallback, useEffect, useState } from 'react'
import { Bot, ChevronDown, Cog, ChevronRight, History, RotateCcw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { api, ApiError, withShare } from '@/lib/api'
import { authorColor, sourceLabel, type Source } from '@/lib/authors'
import { relativeTime, shortDateTime } from '@/lib/time'
import { describe, type AuditEvent as Event } from '@/lib/events'
import { cn } from '@/lib/utils'

interface Author {
  user_id: string
  name: string
  source: Source
}

interface Revision {
  id: number
  authors: Author[]
  sources: Source[]
  added: number
  removed: number
  started_at: string
  ended_at: string
  patch?: string
  text?: string
}

interface Entry {
  kind: 'revision' | 'event'
  at: string
  revision?: Revision
  event?: Event
}

interface TimelineData {
  entries: Entry[]
  pending: { authors: Author[]; since: string } | null
}

export function SourceBadge({ source }: { source: Source }) {
  if (source === 'human') return null
  const Icon = source === 'agent' ? Bot : source === 'ai_assisted' ? Sparkles : source === 'system' ? Cog : RotateCcw
  return (
    <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] font-medium">
      <Icon className="size-3" /> {sourceLabel[source]}
    </Badge>
  )
}

function Avatar({ name, id }: { name: string; id: string }) {
  return (
    <span
      className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
      style={{ backgroundColor: authorColor(id || name) }}
      title={name}
    >
      {(name || '?').slice(0, 1).toUpperCase()}
    </span>
  )
}

function DiffView({ patch }: { patch: string }) {
  return (
    <pre className="mt-2 max-h-80 overflow-auto rounded-md border bg-card p-2 font-mono text-[11px] leading-relaxed">
      {patch.split('\n').map((line, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre-wrap',
            line.startsWith('+') && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
            line.startsWith('-') && 'bg-red-500/10 text-red-700 dark:text-red-300',
            line.startsWith('@@') && 'text-muted-foreground',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

interface SuggestionDetail {
  id: string
  original: string
  proposed: string
  reason: string
  status: 'pending' | 'accepted' | 'rejected'
  author_name: string
  source: Source
  decided_by?: string
  stale: boolean
  detached: boolean
}

interface ThreadDetail {
  id: string
  quote: string
  status: string
  detached: boolean
  comments: { id: string; author_name: string; source: Source; body: string; created_at: string }[]
}

function SuggestionDetails({ alias, id, canDecide, onShow, onChanged }: { alias: string; id: string; canDecide: boolean; onShow: (id: string) => void; onChanged: () => void }) {
  const [sg, setSg] = useState<SuggestionDetail | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    api.get<SuggestionDetail>(withShare(`/api/notes/${alias}/suggestions/${id}`)).then(setSg).catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [alias, id])
  useEffect(load, [load])
  if (error) return <p className="mt-2 text-xs text-muted-foreground">This suggestion is no longer available.</p>
  if (!sg) return null
  const decide = async (accept: boolean) => {
    const base = `/api/notes/${alias}/suggestions/${id}/`
    try {
      if (accept) {
        try {
          await api.post(base + 'accept')
        } catch (e) {
          if (e instanceof ApiError && e.code === 'stale' && confirm('The text changed since this suggestion. Apply it anyway?')) await api.post(base + 'accept', { force: true })
          else throw e
        }
      } else await api.post(base + 'reject')
      load()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const statusText = sg.status === 'pending' ? (sg.stale ? 'Pending, the text changed since' : 'Pending') : `${sg.status === 'accepted' ? 'Accepted' : 'Rejected'}${sg.decided_by ? ' by ' + sg.decided_by : ''}`
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid="timeline-suggestion">
      <div className="text-xs text-muted-foreground">{statusText}</div>
      {sg.original && <div className="max-h-40 overflow-auto rounded bg-red-500/10 px-2 py-1 font-mono text-xs whitespace-pre-wrap line-through decoration-red-500/60">{sg.original}</div>}
      {sg.proposed && <div className="max-h-60 overflow-auto rounded bg-emerald-500/10 px-2 py-1 font-mono text-xs whitespace-pre-wrap">{sg.proposed}</div>}
      {sg.reason && <p className="text-xs">{sg.reason}</p>}
      <div className="flex flex-wrap gap-1.5 pt-1">
        {sg.status === 'pending' && !sg.detached && (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => onShow(id)}>
            Show in editor
          </Button>
        )}
        {sg.status === 'pending' && canDecide && (
          <>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => decide(false)}>
              Reject
            </Button>
            <Button size="sm" variant="outline" className="h-7" onClick={() => decide(true)}>
              Accept
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function ThreadDetails({ alias, id, onShow }: { alias: string; id: string; onShow: (id: string) => void }) {
  const [th, setTh] = useState<ThreadDetail | null | undefined>(undefined)
  useEffect(() => {
    api.get<{ threads: ThreadDetail[] }>(withShare(`/api/notes/${alias}/comments`)).then((r) => setTh(r.threads.find((t) => t.id === id) ?? null))
  }, [alias, id])
  if (th === undefined) return null
  if (th === null) return <p className="mt-2 text-xs text-muted-foreground">This thread was deleted.</p>
  return (
    <div className="mt-2 flex flex-col gap-1.5" data-testid="timeline-thread">
      <blockquote className={cn('border-l-2 border-yellow-500/70 pl-2 text-xs text-muted-foreground', th.detached && 'line-through')}>{th.quote}</blockquote>
      {th.comments.map((c) => (
        <div key={c.id} className="text-xs">
          <span className="font-medium">{c.author_name}</span> <span className="text-muted-foreground">{relativeTime(c.created_at)}</span>
          <p className="whitespace-pre-wrap">{c.body}</p>
        </div>
      ))}
      <div className="flex gap-1.5 pt-1">
        <span className="text-xs text-muted-foreground">{th.status === 'resolved' ? 'Resolved' : 'Open'}</span>
        {!th.detached && (
          <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => onShow(id)}>
            Show in editor
          </Button>
        )}
      </div>
    </div>
  )
}

function EventRow({ alias, ev, at, canDecide, onShow, onChanged }: { alias: string; ev: Event; at: string; canDecide: boolean; onShow: (id: string) => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const suggestionId = ev.kind.startsWith('suggestion.') ? String(ev.data?.suggestion ?? '') : ''
  const threadId = ev.kind.startsWith('comment.') && ev.kind !== 'comment.delete' ? String(ev.data?.thread ?? '') : ''
  const expandable = !!(suggestionId || threadId)
  const head = (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{ev.actor_name}</span>
        <span className="text-muted-foreground">{describe(ev)}</span>
        <SourceBadge source={ev.source} />
      </div>
      <div className="text-xs text-muted-foreground" title={shortDateTime(at)}>
        {relativeTime(at)}
        {ev.client ? ` · via ${ev.client}` : ''}
      </div>
    </div>
  )
  return (
    <li className="flex gap-3 pb-5 text-sm" data-testid="timeline-event">
      <Avatar name={ev.actor_name} id={ev.actor_name} />
      <div className="min-w-0 flex-1">
        {expandable ? (
          <button className="flex w-full items-start gap-1 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? <ChevronDown className="mt-0.5 size-4 shrink-0" /> : <ChevronRight className="mt-0.5 size-4 shrink-0" />}
            {head}
          </button>
        ) : (
          head
        )}
        {open && suggestionId && <SuggestionDetails alias={alias} id={suggestionId} canDecide={canDecide} onShow={onShow} onChanged={onChanged} />}
        {open && threadId && <ThreadDetails alias={alias} id={threadId} onShow={onShow} />}
      </div>
    </li>
  )
}

function RevisionRow({ alias, rev, canRestore, onRestored }: { alias: string; rev: Revision; canRestore: boolean; onRestored: () => void }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<Revision | null>(null)
  const toggle = async () => {
    if (!full) setFull(await api.get<Revision>(withShare(`/api/notes/${alias}/revisions/${rev.id}`)))
    setOpen(!open)
  }
  const restore = async () => {
    if (!confirm('Replace the current text with this version? The change is recorded in the timeline.')) return
    await api.post(`/api/notes/${alias}/revisions/${rev.id}/restore`)
    toast.success('Version restored')
    onRestored()
  }
  const names = [...new Set(rev.authors.map((a) => a.name || 'someone'))]
  return (
    <li className="relative flex gap-3 pb-5" data-testid="timeline-revision">
      <div className="flex -space-x-2">
        {rev.authors.slice(0, 3).map((a) => (
          <Avatar key={a.user_id + a.source} name={a.name} id={a.user_id} />
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <button className="flex w-full items-start gap-1 text-left" onClick={toggle}>
          {open ? <ChevronDown className="mt-0.5 size-4 shrink-0" /> : <ChevronRight className="mt-0.5 size-4 shrink-0" />}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="font-medium">{names.join(', ')}</span>
              <span className="text-muted-foreground">edited</span>
              {rev.sources.map((s) => (
                <SourceBadge key={s} source={s} />
              ))}
            </div>
            <div className="flex gap-2 text-xs text-muted-foreground">
              <span title={shortDateTime(rev.ended_at)}>{relativeTime(rev.ended_at)}</span>
              <span className="text-emerald-600">+{rev.added}</span>
              <span className="text-red-600">−{rev.removed}</span>
            </div>
          </div>
        </button>
        {open && full?.patch && (
          <>
            <DiffView patch={full.patch} />
            {canRestore && (
              <Button size="sm" variant="outline" className="mt-2" onClick={restore}>
                <RotateCcw className="size-3.5" /> Restore this version
              </Button>
            )}
          </>
        )}
      </div>
    </li>
  )
}

export function Timeline({
  alias,
  open,
  onOpenChange,
  canRestore,
  refreshKey,
  onShow,
  onChanged,
}: {
  alias: string
  open: boolean
  onOpenChange: (o: boolean) => void
  canRestore: boolean
  refreshKey: number
  onShow: (id: string) => void
  onChanged: () => void
}) {
  const [data, setData] = useState<TimelineData | null>(null)
  const load = useCallback(() => {
    api.get<TimelineData>(withShare(`/api/notes/${alias}/timeline`)).then(setData).catch(() => {})
  }, [alias])
  useEffect(() => {
    if (!open) return
    load()
    const t = setInterval(load, 20_000)
    return () => clearInterval(t)
  }, [open, load, refreshKey])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <History className="size-4" /> Timeline
          </SheetTitle>
          <SheetDescription>Every edit session, comment and permission change.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {data?.pending && (
            <div className="mb-4 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              Editing now: {data.pending.authors.map((a) => a.name).join(', ')} since {relativeTime(data.pending.since)}
            </div>
          )}
          <ol className="flex flex-col" data-testid="timeline">
            {data?.entries.map((e) =>
              e.revision ? (
                <RevisionRow key={'r' + e.revision.id} alias={alias} rev={e.revision} canRestore={canRestore} onRestored={load} />
              ) : e.event ? (
                <EventRow
                  key={'e' + e.event.id}
                  alias={alias}
                  ev={e.event}
                  at={e.at}
                  canDecide={canRestore}
                  onShow={(id) => {
                    onOpenChange(false)
                    onShow(id)
                  }}
                  onChanged={() => {
                    load()
                    onChanged()
                  }}
                />
              ) : null,
            )}
          </ol>
          {data && data.entries.length === 0 && <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>}
        </div>
      </SheetContent>
    </Sheet>
  )
}
