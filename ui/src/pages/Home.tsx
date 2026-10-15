import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ChevronDown, Eye, FileText, FileUp, Pin, PinOff, Presentation, Search, Tag, X } from 'lucide-react'
import { AppHeader, NewNoteButton } from '@/components/AppHeader'
import { SignInCard } from '@/pages/Login'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { api, noteTitle, type NoteSummary, type TagCount } from '@/lib/api'
import { useMe } from '@/lib/me'
import { importFiles, isImportable } from '@/lib/importNotes'
import { relativeTime } from '@/lib/time'
import { authorColor } from '@/lib/authors'
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
  const [reload, setReload] = useState(0)
  const navigate = useNavigate()
  const drop = useDropImport(() => setReload((n) => n + 1), (alias) => navigate('/n/' + alias))

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
  }, [me, scope, tag, q, reload])

  useEffect(() => {
    if (!me?.authenticated) return
    api.get<{ tags: TagCount[] }>('/api/tags').then((r) => setTags(r.tags))
  }, [me, reload])

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
            { id: 'all', label: 'All documents' },
          ]
        : [
            { id: 'recent', label: 'Recent' },
            { id: 'mine', label: 'My documents' },
            { id: 'shared', label: 'Shared with me' },
            { id: 'all', label: 'All' },
          ],
    [me],
  )

  if (me && !me.authenticated) return <SignInCard next="/" />

  return (
    <div className="min-h-screen" {...drop.handlers}>
      {drop.over && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" data-testid="drop-overlay">
          <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary/60 bg-card px-16 py-12 text-center shadow-lg">
            <FileUp className="size-8 text-primary" />
            <div className="font-medium">Drop to import</div>
            <div className="text-sm text-muted-foreground">A greydoc .zip with its uploads, or a Markdown file</div>
          </div>
        </div>
      )}
      <AppHeader>
        <div className="relative ml-4 hidden max-w-md flex-1 sm:block">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles, tags and text"
            className="pl-8"
            aria-label="Search documents"
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
              {q || tag ? 'No documents match.' : scope === 'recent' ? 'Documents you open appear here.' : 'No documents yet.'}
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
                  <div className={cn('font-medium leading-snug', n.slides ? 'pr-12' : 'pr-6')}>{noteTitle(n)}</div>
                  {(n.snippet || n.description) && <p className="line-clamp-3 text-sm text-muted-foreground">{n.snippet || n.description}</p>}
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1 text-xs text-muted-foreground">
                    {n.tags.length === 0 && <span className="h-5" />}
                    {n.tags.map((t) => (
                      <span
                        key={t}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.preventDefault()
                          update({ tag: t })
                        }}
                        className="rounded-md bg-muted/70 px-1.5 py-0.5 text-foreground/80 hover:text-primary"
                      >
                        <span className="text-muted-foreground">#</span>
                        {t}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 border-t pt-2 text-xs text-muted-foreground" data-testid="note-meta">
                    {n.owner && (
                      <span className="flex min-w-0 items-center gap-1" title={'Owner: ' + n.owner}>
                        <span
                          className="flex size-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold text-white"
                          style={{ backgroundColor: authorColor(n.owner) }}
                        >
                          {n.owner.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="truncate">{n.owner}</span>
                      </span>
                    )}
                    <span className="ml-auto flex shrink-0 items-center gap-1" title={`${n.view_count} views`}>
                      <Eye className="size-3" /> {n.view_count}
                    </span>
                    <span className="shrink-0">·</span>
                    <span className="shrink-0">{relativeTime(n.visited_at && scope === 'recent' ? n.visited_at : n.updated_at)}</span>
                  </div>
                </Link>
                {n.slides && (
                  <a
                    href={'/p/' + n.alias}
                    target="_blank"
                    rel="noreferrer"
                    className="absolute top-3 right-9 text-muted-foreground hover:text-primary"
                    aria-label="Present"
                    title="Present the slides"
                  >
                    <Presentation className="size-4" />
                  </a>
                )}
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

// TagFilter shows one row of the most used tags. "All tags" opens a searchable list. The selected tag stays in view.
function TagFilter({ tags, selected, onSelect }: { tags: TagCount[]; selected: string; onSelect: (tag: string) => void }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ordered = useMemo(() => {
    const sel = tags.find((t) => t.tag === selected)
    return sel ? [sel, ...tags.filter((t) => t !== sel)] : tags
  }, [tags, selected])
  const matches = tags.filter((t) => t.tag.toLowerCase().includes(filter.trim().toLowerCase()))
  const pick = (tag: string) => {
    onSelect(selected === tag ? '' : tag)
    setOpen(false)
  }

  return (
    <div className="mb-6 flex items-center gap-2">
      <Tag className="size-3.5 shrink-0 text-muted-foreground" />
      {/* One row only: tags that do not fit wrap to a hidden second row. */}
      <div className="flex h-6 min-w-0 flex-1 flex-wrap gap-1.5 overflow-hidden" data-testid="tag-filter">
        {ordered.map((t) => (
          <TagChip key={t.tag} tag={t} selected={selected === t.tag} onClick={() => pick(t.tag)} />
        ))}
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground">
            All {tags.length} tags <ChevronDown className="size-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-2" data-testid="tag-list">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tags" className="mb-2 h-8" autoFocus />
          <div className="max-h-72 overflow-y-auto">
            {matches.map((t) => (
              <button
                key={t.tag}
                onClick={() => pick(t.tag)}
                aria-label={`${t.tag}, ${t.count} ${t.count === 1 ? 'document' : 'documents'}`}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted',
                  selected === t.tag && 'font-medium text-primary',
                )}
              >
                <span className="text-muted-foreground">#</span>
                <span className="min-w-0 flex-1 truncate">{t.tag}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{t.count}</span>
              </button>
            ))}
            {matches.length === 0 && <p className="px-2 py-3 text-center text-sm text-muted-foreground">No tag matches.</p>}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function TagChip({ tag, selected, onClick }: { tag: TagCount; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`${tag.tag}, ${tag.count} ${tag.count === 1 ? 'document' : 'documents'}`}
      className={cn(
        'inline-flex h-6 items-center rounded-md border px-2 text-xs transition-colors',
        selected
          ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border-border/70 bg-card text-foreground/80 hover:border-primary/60 hover:text-foreground',
      )}
    >
      <span className={selected ? 'opacity-70' : 'text-muted-foreground'}>#</span>
      {tag.tag}
      <span className={cn('ml-1.5 tabular-nums', selected ? 'opacity-70' : 'text-muted-foreground')}>{tag.count}</span>
    </button>
  )
}

// useDropImport turns files dropped on the page into notes. Only drags that carry files count.
function useDropImport(onDone: () => void, open: (alias: string) => void) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')
  const run = async (files: File[]) => {
    const ok = files.filter((f) => isImportable(f.name))
    if (ok.length === 0) {
      toast.error('Drop a greydoc .zip or a Markdown file.')
      return
    }
    const t = toast.loading(ok.length === 1 ? `Importing ${ok[0].name}…` : `Importing ${ok.length} files…`)
    const results = await importFiles(ok)
    toast.dismiss(t)
    for (const r of results) {
      if (r.error || !r.note) {
        toast.error(`${r.file}: ${r.error}`)
        continue
      }
      const n = r.note
      const action = { label: 'Open', onClick: () => open(n.alias) }
      if (n.renamed) toast.warning(`Imported “${n.title || r.file}” at /${n.alias}. Its old address is taken here.`, { action })
      else toast.success(`Imported “${n.title || r.file}”`, { action })
    }
    onDone()
  }
  return {
    over,
    handlers: {
      onDragEnter: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        depth.current++
        setOver(true)
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      },
      onDragOver: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDrop: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        void run(Array.from(e.dataTransfer.files))
      },
    },
  }
}
