import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { EditorView } from '@codemirror/view'
import {
  CircleHelp,
  Columns2,
  Download,
  Eye,
  FilePenLine,
  FileCode,
  History,
  MessageSquare,
  MessageSquarePlus,
  Users,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Presentation,
  ScrollText,
  Share2,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Logo } from '@/components/Logo'
import { SyntaxHelp } from '@/components/SyntaxHelp'
import { ThemeToggle, UserMenu } from '@/components/AppHeader'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Spinner } from '@/components/ui/spinner'
import { ShareDialog } from '@/components/ShareDialog'
import { Timeline } from '@/components/Timeline'
import { CommentsPanel, type Draft, type Suggestion, type Thread } from '@/components/CommentsPanel'
import { SuggestComposer, type SuggestDraft } from '@/components/SuggestComposer'
import { AiMenu } from '@/components/AiMenu'
import { imageUpload } from '@/editor/upload'
import { canToggleTasks } from '@/editor/live'
import { taskToggle } from '@/lib/tasks'
import { captureEdits, setSuggestionRanges, suggestionDecorations, type SuggestionAction } from '@/editor/suggestions'
import { anchorRange, resolvePoint, resolveRange } from '@/editor/anchors'
import { setThreadRanges, threadDecorations } from '@/editor/threads'
import { selectionListener, type SelectionInfo } from '@/editor/selection'
import { EditorView as CMView } from '@codemirror/view'
import { attribution, setClients } from '@/editor/attribution'
import { authorColor, sourceLabel, type NoteClient } from '@/lib/authors'
import { CodeEditor } from '@/editor/CodeEditor'
import { NoteSession, type AppEvent } from '@/editor/session'
import { Preview, scrollToSourceLine } from '@/render/Preview'
import { api, ApiError, atLeast, shareParam, withShare, type Level, type Note } from '@/lib/api'
import { loginHref, useMe } from '@/lib/me'
import { localName, presenceColor } from '@/lib/presence'
import { extractTitle } from '@/lib/meta'
import { cn } from '@/lib/utils'
import { shortDateTime } from '@/lib/time'

type Mode = 'live' | 'edit' | 'both' | 'view'

const toolbarButton = 'h-7 gap-1 px-2 text-background hover:bg-background/15 hover:text-background'

const MODE_KEY = 'greydoc-mode'
// Split view, as in HedgeDoc, until the user picks another mode.
const defaultEditMode: Mode = 'both'

// savedMode reads HedgeDoc 1's ?view, ?edit and ?both first, then the last mode used in this browser.
function savedMode(): Mode {
  const q = new URLSearchParams(location.search)
  for (const m of ['view', 'edit', 'both'] as const) if (q.has(m)) return m
  const m = localStorage.getItem(MODE_KEY)
  return m === 'live' || m === 'edit' || m === 'both' || m === 'view' ? m : defaultEditMode
}

interface PresenceUser {
  clientId: number
  name: string
  color: string
}

function useYText(session: NoteSession | null): string {
  const [text, setText] = useState('')
  useEffect(() => {
    if (!session) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = () => {
      clearTimeout(timer)
      timer = setTimeout(() => setText(session.text.toString()), 120)
    }
    setText(session.text.toString())
    session.text.observe(update)
    return () => {
      clearTimeout(timer)
      session.text.unobserve(update)
    }
  }, [session])
  return text
}

function usePresence(session: NoteSession | null): PresenceUser[] {
  const [users, setUsers] = useState<PresenceUser[]>([])
  useEffect(() => {
    if (!session) return
    const aw = session.provider.awareness
    const update = () => {
      const out: PresenceUser[] = []
      aw.getStates().forEach((st, id) => {
        const u = (st as { user?: { name?: string; color?: string } }).user
        if (u?.name) out.push({ clientId: id, name: u.name, color: u.color ?? '#888' })
      })
      setUsers(out)
    }
    update()
    aw.on('change', update)
    return () => aw.off('change', update)
  }, [session])
  return users
}

export default function Editor() {
  const { alias = '' } = useParams()
  const navigate = useNavigate()
  const { me } = useMe()
  const [note, setNote] = useState<Note | null>(null)
  const [error, setError] = useState<string>('')
  const [inTrash, setInTrash] = useState(false)
  const [level, setLevel] = useState<Level>('read')
  const [mode, setModeState] = useState<Mode>(savedMode)
  const setMode = useCallback((m: Mode) => {
    setModeState(m)
    localStorage.setItem(MODE_KEY, m)
  }, [])
  const [session, setSession] = useState<NoteSession | null>(null)
  const [synced, setSynced] = useState(false)
  // The editor mounts after the first sync, so it opens on the real text and not on an empty document.
  const [loaded, setLoaded] = useState(false)
  const [connected, setConnected] = useState(true)
  const [shareOpen, setShareOpen] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [timelineKey, setTimelineKey] = useState(0)
  const [showAuthors, setShowAuthors] = useState(false)
  const [clients, setClientsState] = useState<NoteClient[]>([])
  const [rawThreads, setRawThreads] = useState<Thread[]>([])
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [rawSuggestions, setRawSuggestions] = useState<Suggestion[]>([])
  const [suggesting, setSuggesting] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [suggestDraft, setSuggestDraft] = useState<SuggestDraft | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const sessionRef = useRef<NoteSession | null>(null)
  const previewPane = useRef<HTMLElement | null>(null)
  const article = useRef<HTMLElement | null>(null)
  const text = useYText(session)
  const presence = usePresence(session)

  useEffect(() => {
    setNote(null)
    setError('')
    setInTrash(false)
    api
      .get<Note>(withShare(`/api/notes/${alias}?visit=1`))
      .then((n) => {
        setNote(n)
        setLevel(n.level)
        if (!atLeast(n.level, 'comment')) setModeState('view')
        if (n.alias !== alias.toLowerCase()) navigate('/n/' + n.alias + location.search, { replace: true })
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          location.href = loginHref()
          return
        }
        if (e instanceof ApiError && e.code === 'in_trash') setInTrash(true)
        setError(
          e instanceof ApiError && e.status === 404
            ? 'This note does not exist.'
            : e instanceof ApiError && e.code === 'in_trash'
              ? 'This note is in the trash.'
              : e instanceof Error
                ? e.message
                : String(e),
        )
      })
  }, [alias, navigate])

  useEffect(() => {
    if (!note || !me) return
    const s = new NoteSession(note.alias, { name: me.local_mode ? localName() : undefined, share: shareParam() })
    s.setUser({ name: me.local_mode ? localName() : me.display_name || me.username || 'guest', color: presenceColor() })
    const onSync = (v: boolean) => {
      setSynced(v)
      if (v) setLoaded(true)
    }
    const onStatus = (e: { status: string }) => setConnected(e.status === 'connected')
    s.provider.on('sync', onSync)
    s.provider.on('status', onStatus)
    const off = s.onEvent((ev: AppEvent) => {
      if (ev.type === 'access' && ev.level) {
        setLevel(ev.level)
        if (ev.level === 'deny') toast.error('Your access to this note was removed.')
      }
      if (ev.type === 'timeline') setTimelineKey((k) => k + 1)
      if (ev.type === 'comments') loadThreadsRef.current()
      if (ev.type === 'suggestions') loadSuggestionsRef.current()
      if (ev.type === 'deleted' || ev.type === 'trashed') {
        toast.error(ev.type === 'trashed' ? 'This note was moved to the trash.' : 'This note was deleted.')
        navigate('/')
      }
    })
    setSession(s)
    sessionRef.current = s
    const fallback = setTimeout(() => setLoaded(true), 4000)
    return () => {
      off()
      s.provider.off('sync', onSync)
      s.provider.off('status', onStatus)
      clearTimeout(fallback)
      s.destroy()
      setSession(null)
      setSynced(false)
      setLoaded(false)
    }
  }, [note, me, navigate])

  const canEdit = atLeast(level, 'write')
  const isOwner = level === 'full'
  const title = useMemo(() => extractTitle(text) || note?.title || 'Untitled', [text, note])

  useEffect(() => {
    document.title = title + ' · greydoc'
  }, [title])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.altKey) return
      const next = ({ KeyL: 'live', KeyE: 'edit', KeyB: 'both', KeyV: 'view' } as Record<string, Mode>)[e.code]
      if (next) {
        e.preventDefault()
        setMode(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const syncScroll = useCallback(() => {
    const v = viewRef.current
    if (!v || !previewPane.current || !article.current) return
    const block = v.lineBlockAtHeight(v.scrollDOM.scrollTop - v.documentTop + v.scrollDOM.getBoundingClientRect().top)
    const line = v.state.doc.lineAt(block.from).number - 1
    const fraction = block.height ? (v.scrollDOM.scrollTop - block.top) / block.height : 0
    scrollToSourceLine(previewPane.current, article.current, line, Math.max(0, Math.min(1, fraction)))
  }, [])

  const loadThreads = useCallback(() => {
    if (!note) return
    api.get<{ threads: Thread[] }>(withShare(`/api/notes/${note.alias}/comments`)).then((r) => setRawThreads(r.threads))
  }, [note])
  const loadThreadsRef = useRef(loadThreads)
  loadThreadsRef.current = loadThreads
  useEffect(loadThreads, [loadThreads])

  const loadSuggestions = useCallback(() => {
    if (!note) return
    api.get<{ suggestions: Suggestion[] }>(withShare(`/api/notes/${note.alias}/suggestions`)).then((r) => setRawSuggestions(r.suggestions))
  }, [note])
  const loadSuggestionsRef = useRef(loadSuggestions)
  loadSuggestionsRef.current = loadSuggestions
  useEffect(loadSuggestions, [loadSuggestions])

  const suggestions = useMemo(
    () =>
      session
        ? rawSuggestions.map((sg) => {
            const range = sg.original
              ? resolveRange(session.doc, sg.anchor_start, sg.anchor_end)
              : resolvePoint(session.doc, sg.anchor_start)
            const stale = !range || session.text.toString().slice(range.from, range.to) !== sg.original
            return { ...sg, range, stale }
          })
        : rawSuggestions,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawSuggestions, session, text],
  )

  const decide = useCallback(
    async (sg: Suggestion, accept: boolean) => {
      if (!note) return
      const base = `/api/notes/${note.alias}/suggestions/${sg.id}/`
      try {
        if (accept) {
          try {
            await api.post(base + 'accept')
          } catch (e) {
            if (e instanceof ApiError && e.code === 'stale' && confirm('The text changed since this suggestion. Apply it anyway?')) {
              await api.post(base + 'accept', { force: true })
            } else throw e
          }
        } else await api.post(base + 'reject')
        loadSuggestions()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    },
    [note, loadSuggestions],
  )
  const decideRef = useRef(decide)
  decideRef.current = decide
  const suggestionsRef = useRef(suggestions)
  suggestionsRef.current = suggestions

  const aliasRef = useRef(alias)
  aliasRef.current = note?.alias ?? alias
  const canEditRef = useRef(false)
  canEditRef.current = atLeast(level, 'write') && !suggesting

  const isCommenter = level === 'comment'
  const suggestingRef = useRef(false)
  suggestingRef.current = isCommenter || suggesting

  useEffect(() => {
    const myId = me?.id
    viewRef.current?.dispatch({
      effects: setSuggestionRanges.of(
        suggestions
          .filter((sg) => sg.range)
          .map((sg) => ({
            id: sg.id,
            from: sg.range!.from,
            to: sg.range!.to,
            proposed: sg.proposed,
            author: sg.author_name,
            source: sg.source,
            stale: !!sg.stale,
            canDecide: atLeast(level, 'write'),
            canWithdraw: sg.author_id === myId,
          })),
      ),
    })
  }, [suggestions, level, me])

  const threads = useMemo(
    () => (session ? rawThreads.map((t) => ({ ...t, range: resolveRange(session.doc, t.anchor_start, t.anchor_end) })) : rawThreads),
    // text is a dependency so ranges follow edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawThreads, session, text],
  )

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: setThreadRanges.of(
        threads
          .filter((t) => t.status === 'open' && t.range)
          .map((t) => ({ id: t.id, from: t.range!.from, to: t.range!.to, active: t.id === activeThread, kind: 'comment' as const })),
      ),
    })
  }, [threads, activeThread])

  const selectThread = useCallback((t: Thread) => {
    setActiveThread(t.id)
    const v = viewRef.current
    if (v && t.range) {
      v.dispatch({ selection: { anchor: t.range.from, head: t.range.to }, effects: CMView.scrollIntoView(t.range.from, { y: 'center' }) })
    }
  }, [])

  const editorExtensions = useMemo(
    () => [
      threadDecorations((id) => {
        setActiveThread(id)
        setCommentsOpen(true)
      }),
      selectionListener(setSelection),
      imageUpload(
        () => aliasRef.current,
        () => canEditRef.current,
      ),
      suggestionDecorations((id: string, a: SuggestionAction, instruction?: string) => {
        const sg = suggestionsRef.current.find((x) => x.id === id)
        if (!sg) return
        if (a === 'revise') {
          const t = toast.loading('Asking the AI…')
          api
            .post(withShare(`/api/notes/${aliasRef.current}/suggestions/${id}/revise`), { instruction })
            .then(() => toast.success('New version ready', { id: t }))
            .catch((e) => toast.error(e instanceof Error ? e.message : String(e), { id: t }))
            .finally(() => loadSuggestionsRef.current())
        } else if (a === 'focus') {
          setActiveThread(id)
          setCommentsOpen(true)
        } else decideRef.current(sg, a === 'accept')
      }),
      canToggleTasks.of(() => canEditRef.current),
      captureEdits(
        () => suggestingRef.current,
        (e) => {
          const s = sessionRef.current
          if (!s) return
          setSuggestDraft((d) => {
            if (d && e.from === d.from && e.to === d.to) return { ...d, proposed: e.proposed }
            return { from: e.from, to: e.to, original: e.original, proposed: e.proposed, ...anchorRange(s.text, e.from, e.to) }
          })
        },
      ),
    ],
    [],
  )

  const toggleTask = useCallback(
    (line: number) => {
      if (!session) return
      const edit = taskToggle(session.text.toString(), line)
      if (!edit) return
      session.doc.transact(() => {
        session.text.delete(edit.offset, 1)
        session.text.insert(edit.offset, edit.insert)
      })
    },
    [session],
  )

  const startSuggest = () => {
    if (!session || !selection) return
    setSuggestDraft({
      from: selection.from,
      to: selection.to,
      original: selection.text,
      proposed: selection.text,
      ...anchorRange(session.text, selection.from, selection.to),
    })
  }

  const startComment = () => {
    if (!session || !selection) return
    setDraft({ quote: selection.text.slice(0, 2000), ...anchorRange(session.text, selection.from, selection.to) })
    setCommentsOpen(true)
  }

  const loadClients = useCallback(() => {
    if (!note) return
    api.get<{ clients: NoteClient[] }>(withShare(`/api/notes/${note.alias}/clients`)).then((r) => {
      setClientsState(r.clients)
      viewRef.current?.dispatch({ effects: setClients.of(new Map(r.clients.map((c) => [c.client_id, c]))) })
    })
  }, [note])

  const refreshClients = useMemo(() => {
    let last = 0
    return () => {
      if (Date.now() - last < 3000) return
      last = Date.now()
      setTimeout(loadClients, 0)
    }
  }, [loadClients])

  const authorsOverlay = useMemo(
    () => (showAuthors && session ? attribution(session.text, refreshClients) : []),
    [showAuthors, session, refreshClients],
  )

  useEffect(() => {
    if (showAuthors) loadClients()
  }, [showAuthors, loadClients])

  const legend = useMemo(() => {
    const seen = new Map<string, { name: string; color: string; sources: Set<string> }>()
    for (const c of clients) {
      const key = c.user_id || c.display_name
      const e = seen.get(key) ?? { name: c.display_name || 'Unknown', color: authorColor(key), sources: new Set<string>() }
      if (c.source !== 'human') e.sources.add(sourceLabel[c.source])
      seen.set(key, e)
    }
    return [...seen.values()]
  }, [clients])

  const onView = useCallback(
    (v: EditorView | null) => {
      viewRef.current = v
      v?.scrollDOM.addEventListener('scroll', syncScroll, { passive: true })
    },
    [syncScroll],
  )

  const trashNote = async () => {
    const target = note?.alias ?? alias
    try {
      await api.del('/api/notes/' + target)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      return
    }
    toast.success('Moved to the trash', {
      action: { label: 'Undo', onClick: () => api.post(`/api/notes/${target}/restore`).then(() => navigate('/n/' + target)) },
    })
    navigate('/')
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">{error}</p>
        <div className="flex gap-2">
          {inTrash && (
            <Button
              onClick={() =>
                api
                  .post(`/api/notes/${alias}/restore`)
                  .then(() => location.reload())
                  .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
              }
            >
              Restore it
            </Button>
          )}
          <Button asChild variant="outline">
            <Link to="/">Back to notes</Link>
          </Button>
        </div>
      </div>
    )
  }
  if (!note || !session || !loaded) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    )
  }

  const showEditor = mode !== 'view' && atLeast(level, 'comment')
  const showPreview = (mode !== 'edit' && mode !== 'live') || !atLeast(level, 'comment')

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <Link to="/" className="flex items-center" aria-label="All notes">
            <Logo className="h-5 text-foreground" />
          </Link>
          <h1 className="min-w-0 truncate px-1 text-sm font-medium" data-testid="note-title">
            {title}
          </h1>
          <span
            className={cn('size-2 shrink-0 rounded-full', connected && synced ? 'bg-emerald-500' : 'bg-amber-500')}
            title={connected ? (synced ? 'Connected' : 'Syncing') : 'Offline, reconnecting'}
          />
          {!canEdit && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {level === 'comment' ? 'Suggesting' : 'Read only'}
            </span>
          )}
          {canEdit && suggesting && (
            <button
              className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary hover:bg-primary/20"
              onClick={() => setSuggesting(false)}
              title="Back to editing"
            >
              Suggesting ×
            </button>
          )}
          <div className="flex-1" />
          <div className="mr-1 hidden -space-x-1.5 sm:flex" data-testid="presence">
            {presence.slice(0, 6).map((u) => (
              <Tooltip key={u.clientId}>
                <TooltipTrigger asChild>
                  <span
                    className="flex size-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white"
                    style={{ backgroundColor: u.color }}
                  >
                    {u.name.slice(0, 1).toUpperCase()}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{u.name}</TooltipContent>
              </Tooltip>
            ))}
            {presence.length > 6 && <span className="pl-2 text-xs text-muted-foreground">+{presence.length - 6}</span>}
          </div>
          {atLeast(level, 'comment') && (
            <ToggleGroup type="single" value={mode} onValueChange={(v) => v && setMode(v as Mode)} size="sm" variant="outline">
              <ToggleGroupItem value="live" aria-label="Live (Ctrl+Alt+L)">
                <NotebookPen className="size-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="edit" aria-label="Editor only (Ctrl+Alt+E)">
                <Pencil className="size-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="both" aria-label="Split view (Ctrl+Alt+B)">
                <Columns2 className="size-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="view" aria-label="Preview only (Ctrl+Alt+V)">
                <Eye className="size-4" />
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          {atLeast(level, 'comment') && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showAuthors ? 'secondary' : 'ghost'}
                  size="icon"
                  aria-label="Show authors"
                  aria-pressed={showAuthors}
                  onClick={() => {
                    setShowAuthors(!showAuthors)
                    if (mode === 'view') setMode(defaultEditMode)
                  }}
                >
                  <Users className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Who wrote what</TooltipContent>
            </Tooltip>
          )}
          <Button
            variant={commentsOpen ? 'secondary' : 'ghost'}
            size="sm"
            aria-label="Comments"
            onClick={() => setCommentsOpen(!commentsOpen)}
            className="gap-1 px-2"
          >
            <MessageSquare className="size-4" />
            <span className="text-xs tabular-nums">{threads.filter((t) => t.status === 'open').length + suggestions.length}</span>
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Timeline" onClick={() => setTimelineOpen(true)}>
                <History className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Timeline</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Markdown help" onClick={() => setHelpOpen(true)}>
                <CircleHelp className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Markdown help</TooltipContent>
          </Tooltip>
          {me?.authenticated && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Share" onClick={() => setShareOpen(true)}>
                  <Share2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Share and protect</TooltipContent>
            </Tooltip>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {canEdit && (
                <>
                  <DropdownMenuCheckboxItem checked={suggesting} onCheckedChange={(v) => setSuggesting(Boolean(v))}>
                    Suggest instead of editing
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem asChild>
                <a href={withShare(`/p/${note.alias}`)} target="_blank" rel="noreferrer">
                  <Presentation className="size-4" /> Slide mode
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={withShare(`/s/${note.alias}`)} target="_blank" rel="noreferrer">
                  <Eye className="size-4" /> View mode
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a href={withShare(`/api/notes/${note.alias}/download.md`)}>
                  <Download className="size-4" /> Download Markdown
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={withShare(`/s/${note.alias}?export=html`)}>
                  <FileCode className="size-4" /> Download HTML
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="note-info">
                {note.view_count} {note.view_count === 1 ? 'view' : 'views'} · created {shortDateTime(note.created_at)}
                {note.owner && <div>Owner: {note.owner.display_name || note.owner.username}</div>}
              </div>
              <DropdownMenuItem asChild>
                <Link to={'/audit?note=' + note.alias}>
                  <ScrollText className="size-4" /> Audit log of this note
                </Link>
              </DropdownMenuItem>
              {(isOwner || me?.admin) && (
                <DropdownMenuItem className="text-destructive" onSelect={trashNote}>
                  <Trash2 className="size-4" /> Move to trash
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <ThemeToggle />
          <UserMenu />
        </header>
        <main className="flex min-h-0 flex-1">
          {showEditor && (
            <section className={cn('relative min-w-0 border-r', showPreview ? 'w-1/2' : 'w-full')}>
              {selection && atLeast(level, 'comment') && (
                <div
                  className="absolute z-20 flex items-center gap-0.5 rounded-lg bg-foreground p-1 text-background shadow-lg ring-1 ring-black/10"
                  style={{ top: selection.top, left: Math.max(8, selection.left) }}
                  data-testid="selection-toolbar"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    className={toolbarButton}
                    onClick={startComment}
                    title="Comment: add a remark for others. The text does not change."
                  >
                    <MessageSquarePlus className="size-3.5" /> Comment
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={toolbarButton}
                    onClick={startSuggest}
                    title="Suggest: propose new text. A writer accepts or rejects it."
                  >
                    <FilePenLine className="size-3.5" /> Suggest
                  </Button>
                  {me?.ai_enabled && (
                    <AiMenu
                      triggerClassName={toolbarButton}
                      alias={note.alias}
                      target={() => {
                        const v = viewRef.current
                        if (!v || !session) return null
                        const sel = v.state.selection.main
                        if (sel.empty) return null
                        return { original: v.state.sliceDoc(sel.from, sel.to), ...anchorRange(session.text, sel.from, sel.to) }
                      }}
                      onCreated={loadSuggestions}
                      onStart={() => {
                        const v = viewRef.current
                        if (v) v.dispatch({ selection: { anchor: v.state.selection.main.to } })
                      }}
                    />
                  )}
                </div>
              )}
              {suggestDraft && note && (
                <SuggestComposer
                  alias={note.alias}
                  draft={suggestDraft}
                  top={viewRef.current?.coordsAtPos(suggestDraft.to) ? viewRef.current.coordsAtPos(suggestDraft.to)!.bottom - viewRef.current.dom.getBoundingClientRect().top + 8 : 40}
                  onChange={(proposed) => setSuggestDraft({ ...suggestDraft, proposed })}
                  onDone={(created) => {
                    setSuggestDraft(null)
                    if (created) loadSuggestions()
                    viewRef.current?.focus()
                  }}
                />
              )}
              {showAuthors && legend.length > 0 && (
                <div className="absolute right-3 bottom-3 z-10 flex max-w-[80%] flex-wrap gap-2 rounded-md border bg-card/95 px-2.5 py-1.5 text-xs shadow-sm" data-testid="authors-legend">
                  {legend.map((a) => (
                    <span key={a.name} className="flex items-center gap-1">
                      <span className="size-2.5 rounded-sm" style={{ backgroundColor: a.color }} />
                      {a.name}
                      {a.sources.size > 0 && <span className="text-muted-foreground">({[...a.sources].join(', ')})</span>}
                    </span>
                  ))}
                </div>
              )}
              <CodeEditor
                ytext={session.text}
                awareness={session.provider.awareness}
                readOnly={!atLeast(level, 'comment')}
                overlay={authorsOverlay}
                live={mode === 'live'}
                extensions={editorExtensions}
                onView={onView}
                autoFocus
              />
            </section>
          )}
          {showPreview && (
            <section
              ref={previewPane}
              className={cn('relative min-w-0 overflow-y-auto bg-background', showEditor ? 'w-1/2' : 'w-full')}
            >
              <div className="mx-auto max-w-3xl px-8 py-8">
                <Preview source={text} ref={article} onToggleTask={canEdit && !suggesting ? toggleTask : undefined} />
              </div>
            </section>
          )}
          {commentsOpen && (
            <CommentsPanel
              alias={note.alias}
              threads={threads}
              suggestions={suggestions}
              canDecide={canEdit}
              onDecide={decide}
              draft={draft}
              activeId={activeThread}
              canComment={atLeast(level, 'comment')}
              canModerate={isOwner}
              meId={me?.id}
              onDraftDone={() => setDraft(null)}
              onSelect={selectThread}
              onChanged={loadThreads}
              onClose={() => setCommentsOpen(false)}
            />
          )}
        </main>
        <SyntaxHelp open={helpOpen} onOpenChange={setHelpOpen} />
        <ShareDialog alias={note.alias} isOwner={isOwner} open={shareOpen} onOpenChange={setShareOpen} />
        <Timeline
          alias={note.alias}
          open={timelineOpen}
          onOpenChange={setTimelineOpen}
          canRestore={canEdit}
          refreshKey={timelineKey}
          onShow={(id) => {
            setCommentsOpen(true)
            if (mode === 'view') setMode(defaultEditMode)
            const item = [...threads, ...suggestions].find((x) => x.id === id)
            if (item) selectThread(item as Thread)
            else setActiveThread(id)
          }}
          onChanged={() => {
            loadSuggestions()
            loadThreads()
          }}
        />
      </div>
    </TooltipProvider>
  )
}
