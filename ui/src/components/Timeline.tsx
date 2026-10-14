import { useCallback, useEffect, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, History, RotateCcw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { api, withShare } from '@/lib/api'
import { authorColor, sourceLabel, type Source } from '@/lib/authors'
import { relativeTime, shortDateTime } from '@/lib/time'
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

interface Event {
  id: string
  actor_name: string
  source: Source
  client?: string
  kind: string
  data: Record<string, unknown>
  created_at: string
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

function SourceBadge({ source }: { source: Source }) {
  if (source === 'human') return null
  const Icon = source === 'agent' ? Bot : source === 'ai_assisted' ? Sparkles : RotateCcw
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

const levelWords: Record<string, string> = { deny: 'no access', read: 'view access', comment: 'comment access', write: 'edit access' }

function describe(e: Event): string {
  const d = e.data ?? {}
  switch (e.kind) {
    case 'note.create':
      return 'created the note'
    case 'note.delete':
      return 'deleted the note'
    case 'permission.user':
      return d.level === 'deny' ? `removed @${d.username}` : `gave @${d.username} ${levelWords[String(d.level)] ?? d.level}`
    case 'permission.group': {
      const g = d.group === '_everyone' ? 'anyone with the address' : d.group === '_signed_in' ? 'signed-in users' : `group ${d.group}`
      return d.level === 'deny' ? `removed access for ${g}` : `gave ${g} ${levelWords[String(d.level)] ?? d.level}`
    }
    case 'permission.owner':
      return `made @${d.username} the owner`
    case 'agent_policy':
      return `set the agent policy to “${d.policy}”`
    case 'share_link.create':
      return 'created a view-only link'
    case 'share_link.revoke':
      return 'revoked a view-only link'
    case 'alias.add':
      return `added the address /${d.alias}`
    case 'alias.primary':
      return `made /${d.alias} the main address`
    case 'alias.remove':
      return `removed the address /${d.alias}`
    case 'revision.restore':
      return `restored the version from ${shortDateTime(String(d.at))}`
    case 'comment.create':
      return `commented: “${String(d.excerpt ?? '')}”`
    case 'comment.reply':
      return `replied: “${String(d.excerpt ?? '')}”`
    case 'comment.resolve':
      return 'resolved a comment'
    case 'comment.reopen':
      return 'reopened a comment'
    case 'comment.delete':
      return 'deleted a comment'
    case 'suggestion.create':
      return 'suggested a change'
    case 'suggestion.accept':
      return 'accepted a suggestion'
    case 'suggestion.reject':
      return 'rejected a suggestion'
    default:
      return e.kind
  }
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

export function Timeline({ alias, open, onOpenChange, canRestore, refreshKey }: { alias: string; open: boolean; onOpenChange: (o: boolean) => void; canRestore: boolean; refreshKey: number }) {
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
                <li key={'e' + e.event.id} className="flex gap-3 pb-5 text-sm">
                  <Avatar name={e.event.actor_name} id={e.event.actor_name} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{e.event.actor_name}</span>
                      <span className="text-muted-foreground">{describe(e.event)}</span>
                      <SourceBadge source={e.event.source} />
                    </div>
                    <div className="text-xs text-muted-foreground" title={shortDateTime(e.at)}>
                      {relativeTime(e.at)}
                      {e.event.client ? ` · via ${e.event.client}` : ''}
                    </div>
                  </div>
                </li>
              ) : null,
            )}
          </ol>
          {data && data.entries.length === 0 && <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>}
        </div>
      </SheetContent>
    </Sheet>
  )
}
