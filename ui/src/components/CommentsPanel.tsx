import { useState } from 'react'
import { Check, MessageSquare, RotateCcw, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { api, withShare } from '@/lib/api'
import { authorColor, sourceLabel, type Source } from '@/lib/authors'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

export interface CommentItem {
  id: string
  author_id: string
  author_name: string
  source: Source
  client?: string
  body: string
  created_at: string
}

export interface Thread {
  id: string
  anchor_start: string
  anchor_end: string
  quote: string
  status: 'open' | 'resolved'
  created_by: string
  created_at: string
  resolved_by?: string
  comments: CommentItem[]
  // Resolved in the browser from the live document.
  range?: { from: number; to: number } | null
}

export interface Draft {
  quote: string
  anchor_start: string
  anchor_end: string
}

function Body({ text }: { text: string }) {
  return <p className="text-sm whitespace-pre-wrap">{text}</p>
}

function ThreadCard({
  alias,
  thread,
  active,
  canModerate,
  meId,
  onSelect,
  onChanged,
}: {
  alias: string
  thread: Thread
  active: boolean
  canModerate: boolean
  meId?: string
  onSelect: () => void
  onChanged: () => void
}) {
  const [reply, setReply] = useState('')
  const base = `/api/notes/${alias}/comments/${thread.id}`
  const detached = thread.range === null
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-3 transition-shadow',
        active && 'border-primary/60 shadow-sm',
        thread.status === 'resolved' && 'opacity-70',
      )}
      data-testid="thread"
      onClick={onSelect}
    >
      <blockquote
        className={cn(
          'mb-2 line-clamp-3 border-l-2 border-yellow-500/70 pl-2 text-xs text-muted-foreground',
          detached && 'line-through',
        )}
      >
        {thread.quote || '…'}
      </blockquote>
      {detached && <div className="mb-2 text-[11px] text-muted-foreground">The commented text was removed.</div>}
      <div className="flex flex-col gap-3">
        {thread.comments.map((c) => (
          <div key={c.id} className="flex gap-2">
            <span
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
              style={{ backgroundColor: authorColor(c.author_id || c.author_name) }}
            >
              {(c.author_name || '?').slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="font-medium">{c.author_name}</span>
                {c.source !== 'human' && (
                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                    {sourceLabel[c.source]}
                  </Badge>
                )}
                <span className="text-muted-foreground">{relativeTime(c.created_at)}</span>
              </div>
              <Body text={c.body} />
            </div>
          </div>
        ))}
      </div>
      {thread.status === 'open' && (
        <form
          className="mt-3 flex flex-col gap-2"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault()
            if (!reply.trim()) return
            act(() => api.post(base + '/replies', { body: reply })).then(() => setReply(''))
          }}
        >
          <Textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply"
            className="min-h-9 resize-none text-sm"
            rows={1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
            }}
          />
          {reply && (
            <Button type="submit" size="sm" className="self-end">
              Reply
            </Button>
          )}
        </form>
      )}
      <div className="mt-2 flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        {(canModerate || thread.created_by === meId) && (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Delete thread"
            onClick={() => confirm('Delete this thread?') && act(() => api.del(base))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
        {thread.status === 'open' ? (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => act(() => api.post(base + '/resolve'))}>
            <Check className="size-3.5" /> Resolve
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => act(() => api.post(base + '/reopen'))}>
            <RotateCcw className="size-3.5" /> Reopen
          </Button>
        )}
      </div>
    </div>
  )
}

export function CommentsPanel({
  alias,
  threads,
  draft,
  activeId,
  canComment,
  canModerate,
  meId,
  onDraftDone,
  onSelect,
  onChanged,
  onClose,
}: {
  alias: string
  threads: Thread[]
  draft: Draft | null
  activeId: string | null
  canComment: boolean
  canModerate: boolean
  meId?: string
  onDraftDone: () => void
  onSelect: (t: Thread) => void
  onChanged: () => void
  onClose: () => void
}) {
  const [body, setBody] = useState('')
  const [showResolved, setShowResolved] = useState(false)
  const open = threads
    .filter((t) => t.status === 'open')
    .sort((a, b) => (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity))
  const resolved = threads.filter((t) => t.status === 'resolved')

  const submit = async () => {
    if (!draft || !body.trim()) return
    try {
      await api.post(withShare(`/api/notes/${alias}/comments`), { ...draft, body })
      setBody('')
      onDraftDone()
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-background" data-testid="comments-panel">
      <div className="flex h-10 items-center gap-2 border-b px-3 text-sm font-medium">
        <MessageSquare className="size-4" /> Comments
        <span className="text-muted-foreground">{open.length}</span>
        <div className="flex-1" />
        <Button size="icon" variant="ghost" className="size-7" aria-label="Close comments" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        {draft && canComment && (
          <div className="rounded-lg border border-primary/60 bg-card p-3">
            <blockquote className="mb-2 line-clamp-3 border-l-2 border-yellow-500/70 pl-2 text-xs text-muted-foreground">
              {draft.quote}
            </blockquote>
            <Textarea
              autoFocus
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Add a comment"
              className="text-sm"
              data-testid="comment-input"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
                if (e.key === 'Escape') onDraftDone()
              }}
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={onDraftDone}>
                Cancel
              </Button>
              <Button size="sm" onClick={submit} disabled={!body.trim()}>
                Comment
              </Button>
            </div>
          </div>
        )}
        {open.map((t) => (
          <ThreadCard key={t.id} alias={alias} thread={t} active={t.id === activeId} canModerate={canModerate} meId={meId} onSelect={() => onSelect(t)} onChanged={onChanged} />
        ))}
        {open.length === 0 && !draft && (
          <p className="px-1 text-sm text-muted-foreground">Select text in the editor and press Comment.</p>
        )}
        {resolved.length > 0 && (
          <button className="self-start px-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowResolved(!showResolved)}>
            {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
          </button>
        )}
        {showResolved &&
          resolved.map((t) => (
            <ThreadCard key={t.id} alias={alias} thread={t} active={t.id === activeId} canModerate={canModerate} meId={meId} onSelect={() => onSelect(t)} onChanged={onChanged} />
          ))}
      </div>
    </aside>
  )
}
