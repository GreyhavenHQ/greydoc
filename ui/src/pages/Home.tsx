import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FileText, Pin, PinOff, Search, X } from 'lucide-react'
import { AppHeader, NewNoteButton } from '@/components/AppHeader'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { api, noteTitle, type NoteSummary, type TagCount } from '@/lib/api'
import { loginHref, useMe } from '@/lib/me'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

type Scope = 'recent' | 'mine' | 'shared' | 'all'

export default function Home() {
  const { me } = useMe()
  const [params, setParams] = useSearchParams()
  const scope = (params.get('scope') as Scope) || 'recent'
  const tag = params.get('tag') ?? ''
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [notes, setNotes] = useState<NoteSummary[] | null>(null)
  const [tags, setTags] = useState<TagCount[]>([])

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
  }

  const q = params.get('q') ?? ''
  useEffect(() => {
    if (!me?.authenticated) return
    const effectiveScope = q || tag ? 'all' : scope
    const sp = new URLSearchParams({ scope: effectiveScope })
    if (tag) sp.set('tag', tag)
    if (q) sp.set('q', q)
    setNotes(null)
    api.get<{ notes: NoteSummary[] }>('/api/notes?' + sp).then((r) => setNotes(r.notes))
  }, [me, scope, tag, q])

  useEffect(() => {
    if (!me?.authenticated) return
    api.get<{ tags: TagCount[] }>('/api/tags').then((r) => setTags(r.tags))
  }, [me])

  useEffect(() => {
    const t = setTimeout(() => {
      if (query !== q) update({ q: query })
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const togglePin = async (n: NoteSummary) => {
    if (n.pinned) await api.del('/api/notes/' + n.alias + '/pin')
    else await api.put('/api/notes/' + n.alias + '/pin')
    setNotes((ns) => ns?.map((x) => (x.id === n.id ? { ...x, pinned: !x.pinned } : x)) ?? null)
  }

  const scopes = useMemo<{ id: Scope; label: string }[]>(
    () =>
      me?.local_mode
        ? [
            { id: 'recent', label: 'Recent' },
            { id: 'all', label: 'All notes' },
          ]
        : [
            { id: 'recent', label: 'Recent' },
            { id: 'mine', label: 'My notes' },
            { id: 'shared', label: 'Shared with me' },
            { id: 'all', label: 'All' },
          ],
    [me],
  )

  if (me && !me.authenticated) {
    return (
      <div className="min-h-screen">
        <AppHeader />
        <main className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-24 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">Shared notes, written together</h1>
          <p className="text-muted-foreground">Sign in to create notes and see the ones shared with you.</p>
          <Button asChild size="lg">
            <a href={loginHref('/')}>Sign in</a>
          </Button>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      <AppHeader>
        <div className="relative ml-4 hidden max-w-md flex-1 sm:block">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles, tags and text"
            className="pl-8"
            aria-label="Search notes"
          />
        </div>
        <div className="flex-1" />
        <NewNoteButton />
      </AppHeader>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          {!q && !tag ? (
            <Tabs value={scope} onValueChange={(v) => update({ scope: v === 'recent' ? '' : v })}>
              <TabsList>
                {scopes.map((s) => (
                  <TabsTrigger key={s.id} value={s.id}>
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Showing</span>
              {tag && (
                <Badge variant="secondary" className="gap-1">
                  #{tag}
                  <button aria-label="Clear tag" onClick={() => update({ tag: '' })}>
                    <X className="size-3" />
                  </button>
                </Badge>
              )}
              {q && (
                <Badge variant="secondary" className="gap-1">
                  “{q}”
                  <button
                    aria-label="Clear search"
                    onClick={() => {
                      setQuery('')
                      update({ q: '' })
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              )}
            </div>
          )}
        </div>

        {tags.length > 0 && <TagFilter tags={tags} selected={tag} onSelect={(t) => update({ tag: t })} />}

        {notes === null ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed py-16 text-center">
            <FileText className="size-8 text-muted-foreground" />
            <p className="text-muted-foreground">
              {q || tag ? 'No notes match.' : scope === 'recent' ? 'Notes you open appear here.' : 'No notes yet.'}
            </p>
            <NewNoteButton size="lg" />
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="note-list">
            {notes.map((n) => (
              <li key={n.id} className="group relative">
                <Link
                  to={'/n/' + n.alias}
                  className="flex h-full flex-col gap-2 rounded-lg border bg-card p-4 transition-colors hover:border-primary/60"
                >
                  <div className="pr-6 font-medium leading-snug">{noteTitle(n)}</div>
                  {(n.snippet || n.description) && <p className="line-clamp-3 text-sm text-muted-foreground">{n.snippet || n.description}</p>}
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1 text-xs text-muted-foreground">
                    {n.tags.map((t) => (
                      <span
                        key={t}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.preventDefault()
                          update({ tag: t })
                        }}
                        className="rounded bg-muted px-1.5 py-0.5 hover:text-primary"
                      >
                        #{t}
                      </span>
                    ))}
                    <span className="ml-auto">{relativeTime(n.visited_at && scope === 'recent' ? n.visited_at : n.updated_at)}</span>
                  </div>
                </Link>
                <button
                  className={cn(
                    'absolute top-3 right-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-primary',
                    n.pinned && 'text-primary opacity-100',
                  )}
                  aria-label={n.pinned ? 'Unpin' : 'Pin'}
                  onClick={() => togglePin(n)}
                >
                  {n.pinned ? <Pin className="size-4" /> : <PinOff className="size-4" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}

// TagFilter shows two lines of tags, most used first, and expands on demand. The selected tag stays in view.
function TagFilter({ tags, selected, onSelect }: { tags: TagCount[]; selected: string; onSelect: (tag: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const ordered = useMemo(() => {
    const sel = tags.find((t) => t.tag === selected)
    return sel ? [sel, ...tags.filter((t) => t !== sel)] : tags
  }, [tags, selected])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ordered, expanded])

  return (
    <div className="mb-6 flex items-start gap-2">
      <div
        ref={box}
        className={cn('flex flex-1 flex-wrap gap-1.5 overflow-hidden', !expanded && 'max-h-[3.25rem]')}
        data-testid="tag-filter"
      >
        {ordered.map((t) => (
          <button
            key={t.tag}
            onClick={() => onSelect(selected === t.tag ? '' : t.tag)}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:border-primary hover:text-primary',
              selected === t.tag && 'border-primary bg-primary text-primary-foreground hover:text-primary-foreground',
            )}
          >
            #{t.tag} <span className="opacity-60">{t.count}</span>
          </button>
        ))}
      </div>
      {(overflows || expanded) && (
        <button
          className="shrink-0 rounded-full px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? 'Show fewer' : `All ${tags.length} tags`}
        </button>
      )}
    </div>
  )
}
