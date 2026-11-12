import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { EditorView } from '@codemirror/view'
import {
  Columns2,
  Copy,
  Download,
  Eye,
  FileArchive,
  FileCode,
  History,
  Link2,
  MessageSquare,
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
import { WithToc } from '@/components/TocSidebar'
import { noteLinkCompletion, type NoteHit } from '@/editor/noteLinks'
import { noteInfo } from '@/render/noteLinks'
import { mentions } from '@/editor/mentions'
import { offerAccess } from '@/components/Mentions'
import { searchPeople } from '@/lib/mentions'
import { UserMenu } from '@/components/AppHeader'
import { NotificationBell } from '@/components/NotificationBell'
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
import { AddressDialog } from '@/components/AddressDialog'
import { Timeline } from '@/components/Timeline'
import { CommentsPanel, type Draft, type Suggestion, type Thread } from '@/components/CommentsPanel'
import { SuggestComposer, type SuggestDraft } from '@/components/SuggestComposer'
import { AiMenu } from '@/components/AiMenu'
import { SelectionToolbar, toolbarButton } from '@/components/SelectionToolbar'
import { imageUpload } from '@/editor/upload'
import { formatKeymap } from '@/editor/format'
import { activeCell, canEditText, defaultLiveStyle, headingPos, linkEditor, linkOpener, tableMenu, type TableMenuRequest } from '@/editor/live'
import { TableMenu } from '@/components/TableMenu'
import { FormatToolbar } from '@/components/FormatToolbar'
import { cellLinkTarget, LinkPopover, linkTarget, type LinkTarget } from '@/components/LinkPopover'
import { LinkCard } from '@/components/LinkCard'
import { linkAt, linkChange, linkInfoAt, type LinkInfo } from '@/editor/format'
import { taskToggle } from '@/lib/tasks'
import { captureEdits, setSuggestionRanges, suggestionDecorations, type SuggestionAction } from '@/editor/suggestions'
import { anchorRange, resolvePoint, resolveRange } from '@/editor/anchors'
import { setThreadRanges, threadDecorations } from '@/editor/threads'
import { selectionListener, type SelectionInfo } from '@/editor/selection'
import { EditorView as CMView } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import * as Y from 'yjs'
import { attribution, setClients } from '@/editor/attribution'
import { personColor, personSeed, sourceLabel, type NoteClient } from '@/lib/authors'
import { PersonAvatar } from '@/components/PersonAvatar'
import { CodeEditor } from '@/editor/CodeEditor'
import { NoteSession, type AppEvent } from '@/editor/session'
import { Preview } from '@/render/Preview'
import { atBottom, editorTopLine, lineForY, measure, scrollEditorToLine, yForLine, type Point } from '@/render/scrollSync'
import { selectionToSource, type SourceSelection } from '@/render/sourceMap'
import { applyThreadMarks, type PreviewThread } from '@/render/previewThreads'
import { api, ApiError, atLeast, duplicateNote, shareParam, withShare, type Level, type Note, type Prefs } from '@/lib/api'
import { loginHref, useMe } from '@/lib/me'
import { localName } from '@/lib/presence'
import { docWidth, docWidthPx, extractTitle, isSlides, widthEdit } from '@/lib/meta'
import { cn } from '@/lib/utils'
import { shortDateTime } from '@/lib/time'
import { modeFromKey, type Mode } from '@/lib/shortcuts'

interface PreviewSelection extends SourceSelection {
  // top, left and bottom are relative to the preview pane's content.
  top: number
  left: number
  bottom: number
}

// The mode chosen with the header buttons holds for one note in one tab.
const MODE_KEY = 'greydoc-mode:'
// Live mode until the user picks another mode in Settings.
const defaultEditMode: Mode = 'live'
const prefModes: Record<NonNullable<Prefs['default_mode']>, Mode> = { live: 'live', editor: 'edit', split: 'both', preview: 'view' }

// startMode reads HedgeDoc 1's ?view, ?edit and ?both first, then the mode of this note in this tab, then the account preference.
// A new note has nothing to read, so it skips a preview-only default.
function startMode(alias: string, fresh: boolean, prefs?: Prefs): Mode {
  const q = new URLSearchParams(location.search)
  for (const m of ['view', 'edit', 'both'] as const) if (q.has(m)) return m
  const m = sessionStorage.getItem(MODE_KEY + alias.toLowerCase())
  if (m === 'live' || m === 'edit' || m === 'both' || m === 'view') return m
  const p = prefs?.default_mode ? prefModes[prefs.default_mode] : defaultEditMode
  return p === 'view' && fresh ? defaultEditMode : p
}

interface PresenceUser {
  clientId: number
  id?: string
  name: string
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
    // The synced text is taken at once, in the same render that ends the connecting state.
    const onSync = (v: boolean) => v && setText(session.text.toString())
    setText(session.text.toString())
    session.text.observe(update)
    session.provider.on('sync', onSync)
    return () => {
      clearTimeout(timer)
      session.text.unobserve(update)
      session.provider.off('sync', onSync)
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
        const u = (st as { user?: { id?: string; name?: string } }).user
        if (u?.name) out.push({ clientId: id, id: u.id, name: u.name })
      })
      setUsers(out)
    }
    update()
    aw.on('change', update)
    return () => aw.off('change', update)
  }, [session])
  return users
}

// searchNotes lists the documents to link to: titles holding every word typed, the ones opened last first.
async function searchNotes(query: string): Promise<NoteHit[]> {
  const sp = new URLSearchParams({ scope: 'all', title: query.trim(), sort: 'visited', limit: '20' })
  return (await api.get<{ notes: NoteHit[] }>('/api/notes?' + sp)).notes
}

// scrollSource calls take when the user starts to scroll or type in el.
function scrollSource(el: HTMLElement, take: () => void) {
  const events = ['pointerenter', 'pointerdown', 'wheel', 'touchstart', 'keydown', 'focusin']
  for (const e of events) el.addEventListener(e, take, { passive: true })
  return () => events.forEach((e) => el.removeEventListener(e, take))
}

export default function Editor() {
  const { alias = '' } = useParams()
  const navigate = useNavigate()
  const { me } = useMe()
  const [note, setNote] = useState<Note | null>(null)
  const [error, setError] = useState<string>('')
  const [inTrash, setInTrash] = useState(false)
  const [level, setLevel] = useState<Level>('read')
  const fresh = Boolean((useLocation().state as { fresh?: boolean } | null)?.fresh)
  const [mode, setModeState] = useState<Mode>(() => startMode(alias, fresh, me?.prefs))
  const setMode = useCallback(
    (m: Mode) => {
      setModeState(m)
      sessionStorage.setItem(MODE_KEY + alias.toLowerCase(), m)
    },
    [alias],
  )
  // Another note starts in its own mode. The preferences can arrive after the first render.
  const prefMode = me?.prefs?.default_mode
  useEffect(() => {
    setModeState(startMode(alias, fresh, me?.prefs))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alias, prefMode])
  const [session, setSession] = useState<NoteSession | null>(null)
  const [synced, setSynced] = useState(false)
  // The editor mounts after the first sync, so it opens on the real text and not on an empty document.
  const [loaded, setLoaded] = useState(false)
  const [connected, setConnected] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [addressOpen, setAddressOpen] = useState(false)
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
  const [suggestDraft, setSuggestDraft] = useState<SuggestDraft | null>(null)
  const [previewSel, setPreviewSel] = useState<PreviewSelection | null>(null)
  const [suggestTop, setSuggestTop] = useState(0)
  const viewRef = useRef<EditorView | null>(null)
  // view follows viewRef so ranges reach an editor that mounts after a mode change.
  const [view, setView] = useState<EditorView | null>(null)
  const sessionRef = useRef<NoteSession | null>(null)
  const previewPane = useRef<HTMLElement | null>(null)
  const article = useRef<HTMLElement | null>(null)
  const [previewEl, setPreviewEl] = useState<HTMLElement | null>(null)
  const text = useYText(session)
  const textRef = useRef(text)
  textRef.current = text
  const presence = usePresence(session)

  const noteRef = useRef<Note | null>(null)
  noteRef.current = note

  useEffect(() => {
    // A URL that names the open note, for example after a slug change, keeps the note and its live connection.
    const cur = noteRef.current
    if (cur && (alias.toLowerCase() === cur.alias || alias.toLowerCase() === cur.id)) return
    setNote(null)
    setError('')
    setInTrash(false)
    api
      .get<Note>(withShare(`/api/notes/${alias}?visit=1`))
      .then((n) => {
        setNote(n)
        setLevel(n.level)
        if (!atLeast(n.level, 'comment')) setModeState('view')
        if (n.alias !== alias.toLowerCase()) navigate('/n/' + n.alias + location.search + location.hash, { replace: true })
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          location.href = loginHref()
          return
        }
        if (e instanceof ApiError && e.code === 'in_trash') setInTrash(true)
        setError(
          e instanceof ApiError && e.status === 404
            ? 'This document does not exist.'
            : e instanceof ApiError && e.code === 'in_trash'
              ? 'This document is in the trash.'
              : e instanceof Error
                ? e.message
                : String(e),
        )
      })
  }, [alias, navigate])

  // applyAlias follows a slug change: the note keeps its session and the URL moves to the new address.
  const applyAlias = useCallback(
    (next: string, aliases?: Note['aliases']) => {
      const cur = noteRef.current
      if (!cur) return
      noteRef.current = { ...cur, alias: next, aliases: aliases ?? cur.aliases }
      setNote(noteRef.current)
      navigate('/n/' + next + location.search + location.hash, { replace: true })
    },
    [navigate],
  )
  const applyAliasRef = useRef(applyAlias)
  applyAliasRef.current = applyAlias

  const noteId = note?.id
  useEffect(() => {
    if (!noteId || !me) return
    const s = new NoteSession(noteId, { name: me.local_mode ? localName() : undefined, share: shareParam() })
    const name = me.local_mode ? localName() : me.display_name || me.username || 'guest'
    s.setUser({ id: me.id, name, color: personColor(personSeed(me.id, name, me.local_mode)) })
    // Timings from page load, reported when a note is slow to arrive.
    const created = performance.now()
    let connectedAt = 0
    let reported = false
    const onSync = (v: boolean) => {
      setSynced(v)
      if (v) setLoaded(true)
      const now = performance.now()
      if (v && !reported && now > 3000) {
        reported = true
        console.warn(
          `greydoc: "${noteId}" took ${(now / 1000).toFixed(1)} s to arrive. WebSocket created at ${(created / 1000).toFixed(1)} s, ` +
            `connected at ${(connectedAt / 1000).toFixed(1)} s, text at ${(now / 1000).toFixed(1)} s, ` +
            `${s.attempts} connection attempt(s)${s.lastClose ? `, last close code ${s.lastClose}` : ''}. ` +
            `The Server-Timing header of the /ws/ request shows how long greydoc itself took.`,
        )
      }
    }
    const onStatus = (e: { status: string }) => {
      if (e.status === 'connected' && !connectedAt) connectedAt = performance.now()
      setConnected(e.status === 'connected')
    }
    s.provider.on('sync', onSync)
    s.provider.on('status', onStatus)
    const off = s.onEvent((ev: AppEvent) => {
      if (ev.type === 'access' && ev.level) {
        setLevel(ev.level)
        if (ev.level === 'deny') toast.error('Your access to this document was removed.')
      }
      if (ev.type === 'refused') {
        const code = Number(ev.code)
        if (code === 4401) location.href = loginHref()
        else {
          if (code === 4410) setInTrash(true)
          setError(code === 4404 ? 'This document does not exist.' : code === 4410 ? 'This document is in the trash.' : 'You do not have access to this document.')
        }
      }
      if (ev.type === 'timeline') setTimelineKey((k) => k + 1)
      if (ev.type === 'alias' && typeof ev.alias === 'string') applyAliasRef.current(ev.alias)
      if (ev.type === 'comments') loadThreadsRef.current()
      if (ev.type === 'suggestions') loadSuggestionsRef.current()
      if (ev.type === 'deleted' || ev.type === 'trashed') {
        toast.error(ev.type === 'trashed' ? 'This document was moved to the trash.' : 'This document was deleted.')
        navigate('/')
      }
    })
    setSession(s)
    sessionRef.current = s
    return () => {
      off()
      s.provider.off('sync', onSync)
      s.provider.off('status', onStatus)
      s.destroy()
      setSession(null)
      setSynced(false)
      setLoaded(false)
    }
  }, [noteId, me, navigate])

  const canEdit = atLeast(level, 'write')
  const isOwner = level === 'full'
  const title = useMemo(() => extractTitle(text) || note?.title || 'Untitled', [text, note])

  useEffect(() => {
    document.title = title + ' · greydoc'
  }, [title])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const next = modeFromKey(e)
      if (next) {
        e.preventDefault()
        setMode(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The reading position is a fractional source line. points maps it to the preview and is rebuilt after a layout change.
  // Only the pane that the user last touched drives the other one, so a synced scroll does not sync back.
  const position = useRef(0)
  const points = useRef<Point[] | null>(null)
  const source = useRef<'editor' | 'preview'>('editor')
  const layoutFrame = useRef(0)
  const editorCleanup = useRef<() => void>(undefined)
  const shownLines = useRef(1)
  const lineCount = useCallback(() => viewRef.current?.state.doc.lines ?? shownLines.current, [])
  const previewPoints = useCallback(() => {
    const pane = previewPane.current
    if (!pane || !article.current) return null
    points.current ??= measure(pane, article.current, lineCount())
    return points.current
  }, [lineCount])
  const syncPreview = useCallback(() => {
    const p = previewPoints()
    if (p) previewPane.current!.scrollTop = yForLine(p, position.current)
  }, [previewPoints])
  const onEditorScroll = useCallback(() => {
    const v = viewRef.current
    if (!v || (source.current !== 'editor' && previewPane.current)) return
    position.current = atBottom(v.scrollDOM) ? v.state.doc.lines : editorTopLine(v)
    syncPreview()
  }, [syncPreview])
  const onPreviewScroll = useCallback(() => {
    const p = previewPoints()
    const pane = previewPane.current
    const v = viewRef.current
    if (!p || !pane || (source.current !== 'preview' && v)) return
    position.current = atBottom(pane) ? lineCount() : lineForY(p, pane.scrollTop)
    if (v) scrollEditorToLine(v, position.current)
  }, [previewPoints, lineCount])
  const onPreviewLayout = useCallback(() => {
    points.current = null
    cancelAnimationFrame(layoutFrame.current)
    layoutFrame.current = requestAnimationFrame(syncPreview)
  }, [syncPreview])

  useEffect(() => {
    if (!previewEl) return
    const ro = new ResizeObserver(onPreviewLayout)
    ro.observe(previewEl)
    if (article.current) ro.observe(article.current)
    previewEl.addEventListener('scroll', onPreviewScroll, { passive: true })
    const stop = scrollSource(previewEl, () => (source.current = 'preview'))
    return () => {
      ro.disconnect()
      previewEl.removeEventListener('scroll', onPreviewScroll)
      stop()
    }
  }, [previewEl, onPreviewLayout, onPreviewScroll])

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
  canEditRef.current = atLeast(level, 'write')
  const mentionsEnabled = Boolean(me?.authenticated && !me.local_mode)
  const onNoAccess = useMemo(() => offerAccess(note?.alias ?? alias, level === 'full'), [note?.alias, alias, level])
  const noAccessRef = useRef(onNoAccess)
  noAccessRef.current = onNoAccess

  const isCommenter = level === 'comment'
  const suggestingRef = useRef(false)
  suggestingRef.current = isCommenter

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
  }, [suggestions, level, me, view])

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
  }, [threads, activeThread, view])

  // previewOnly matches the layout below: no editor pane, only the rendered document.
  const previewOnly = mode === 'view' || !atLeast(level, 'comment')
  const live = Boolean(session && loaded)
  const previewMarks = useMemo<PreviewThread[]>(
    () =>
      previewOnly && live
        ? threads.filter((t) => t.status === 'open' && t.range).map((t) => ({ id: t.id, from: t.range!.from, to: t.range!.to, active: t.id === activeThread }))
        : [],
    [previewOnly, live, threads, activeThread],
  )
  const previewMarksRef = useRef(previewMarks)
  previewMarksRef.current = previewMarks
  const onPreviewRendered = useCallback(
    (root: HTMLElement) => {
      applyThreadMarks(root, textRef.current, previewMarksRef.current)
      onPreviewLayout()
    },
    [onPreviewLayout],
  )
  useEffect(() => {
    if (article.current) applyThreadMarks(article.current, textRef.current, previewMarks)
  }, [previewMarks])

  const commentInPreview = previewOnly && live && atLeast(level, 'comment')
  useEffect(() => {
    setPreviewSel(null)
    if (!commentInPreview) return
    let frame = 0
    const onChange = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const art = article.current
        const pane = previewPane.current
        const sel = document.getSelection()
        if (!art || !pane || !sel || sel.isCollapsed || !sel.rangeCount) return setPreviewSel(null)
        const range = sel.getRangeAt(0)
        const mapped = art.contains(range.commonAncestorContainer) ? selectionToSource(art, range, textRef.current) : null
        if (!mapped) return setPreviewSel(null)
        const box = range.getBoundingClientRect()
        const host = pane.getBoundingClientRect()
        const top = box.top - host.top + pane.scrollTop
        const bottom = box.bottom - host.top + pane.scrollTop
        setPreviewSel({
          ...mapped,
          top: top - 44 > pane.scrollTop + 4 ? top - 44 : bottom + 6,
          left: Math.max(4, Math.min(box.left - host.left, host.width - 300)),
          bottom,
        })
      })
    }
    document.addEventListener('selectionchange', onChange)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', onChange)
    }
  }, [commentInPreview])

  const selectThread = useCallback((t: Thread) => {
    setActiveThread(t.id)
    const v = viewRef.current
    if (v && t.range) {
      v.dispatch({ selection: { anchor: t.range.from, head: t.range.to }, effects: CMView.scrollIntoView(t.range.from, { y: 'center' }) })
    } else {
      article.current?.querySelector(`[data-thread="${CSS.escape(t.id)}"]`)?.scrollIntoView({ block: 'center' })
    }
  }, [])

  // quote defaults to the source text. The preview passes the rendered text when the anchor covers whole blocks.
  const commentOn = useCallback((from: number, to: number, quote?: string) => {
    const s = sessionRef.current
    if (!s) return
    setDraft({ quote: (quote ?? s.text.toString().slice(from, to)).slice(0, 2000), ...anchorRange(s.text, from, to) })
    setCommentsOpen(true)
  }, [])

  // A notification opens the document with ?thread= for a comment or a suggestion, or ?mention=1 for the text.
  const focusTarget = useRef(new URLSearchParams(location.search))
  useEffect(() => {
    const q = focusTarget.current
    const v = viewRef.current
    const id = q.get('thread')
    if (id) {
      const t = threads.find((x) => x.id === id) ?? suggestions.find((x) => x.id === id)
      if (!t) return
      q.delete('thread')
      setCommentsOpen(true)
      setActiveThread(id)
      if (v && t.range) v.dispatch({ selection: { anchor: t.range.from, head: t.range.to }, effects: CMView.scrollIntoView(t.range.from, { y: 'center' }) })
    } else if (q.get('mention') && v && me?.username) {
      q.delete('mention')
      const at = v.state.doc.toString().toLowerCase().indexOf('](@' + me.username.toLowerCase() + ')')
      if (at < 0) return
      const from = v.state.doc.toString().lastIndexOf('[@', at)
      v.dispatch({ selection: { anchor: Math.max(0, from) }, effects: CMView.scrollIntoView(Math.max(0, from), { y: 'center' }) })
    }
  }, [threads, suggestions, loaded, me])

  useEffect(() => {
    const el = article.current
    if (!el) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('a, input, button, img.is-zoomable') || !document.getSelection()?.isCollapsed) return
      const id = target.closest<HTMLElement>('[data-thread]')?.dataset.thread
      if (!id) return
      setActiveThread(id)
      setCommentsOpen(true)
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [previewEl])

  const [tableMenuReq, setTableMenuReq] = useState<TableMenuRequest | null>(null)
  const formatSink = useRef<((s: EditorState) => void) | null>(null)
  // One undo history per note, so it survives a switch to the preview and back.
  const undoManager = useMemo(() => (session ? new Y.UndoManager(session.text) : null), [session])
  useEffect(() => () => undoManager?.destroy(), [undoManager])
  const [linkEdit, setLinkEdit] = useState<LinkTarget | null>(null)
  const openLink = useCallback((v: CMView) => {
    const cell = activeCell(v)
    setLinkEdit(cell ? cellLinkTarget(v, cell) : linkTarget(v))
    return true
  }, [])
  // linkCard is the link under the cursor, shown in a card that opens it.
  const [linkCard, setLinkCard] = useState<{ info: LinkInfo; top: number; left: number } | null>(null)
  // openTarget opens every link of the editor: a heading of this document in place, the app in place, others in a new tab.
  const openTarget = useCallback(
    (url: string) => {
      const v = viewRef.current
      if (url.startsWith('#')) {
        const pos = v && headingPos(v, decodeURIComponent(url.slice(1)))
        if (v && pos !== null) v.dispatch({ selection: { anchor: pos }, effects: CMView.scrollIntoView(pos, { y: 'start' }) })
      } else if (url.startsWith('/')) navigate(url)
      else window.open(url, '_blank', 'noopener,noreferrer')
    },
    [navigate],
  )
  const openTargetRef = useRef(openTarget)
  openTargetRef.current = openTarget
  const linkCards = useMemo(() => {
    let frame = 0
    const place = (v: CMView) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const sel = v.state.selection.main
        const info = sel.empty && v.hasFocus ? linkInfoAt(v.state, sel.head) : null
        const at = info && v.coordsAtPos(info.from, 1)
        if (!info || !at) return setLinkCard(null)
        const host = v.dom.getBoundingClientRect()
        setLinkCard({ info, top: at.bottom - host.top + 6, left: Math.max(4, Math.min(at.left - host.left, host.width - 390)) })
      })
    }
    return [
      CMView.updateListener.of((u) => {
        if (u.selectionSet || u.docChanged || u.geometryChanged || u.focusChanged || u.viewportChanged) place(u.view)
      }),
      CMView.domEventHandlers({
        scroll: (_e, v) => place(v),
        // Ctrl or Cmd and a click opens the link, as in a word processor.
        mousedown(e, v) {
          if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return false
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY })
          const info = pos === null ? null : linkInfoAt(v.state, pos)
          if (!info) return false
          e.preventDefault()
          openTargetRef.current(info.url)
          return true
        },
      }),
    ]
  }, [])
  // selMenu is where a right click on a selection opened Comment and Suggest. Writers see them only then.
  const [selMenu, setSelMenu] = useState<{ top: number; left: number } | null>(null)
  const selectionMenu = useMemo(
    () =>
      CMView.domEventHandlers({
        mousedown(e, v) {
          // A right click keeps the selection, so the menu acts on it. Others keep the menu of the browser.
          if (e.button !== 2 || !canEditRef.current || v.state.selection.main.empty) return false
          e.preventDefault()
          return true
        },
        contextmenu(e, v) {
          if (!canEditRef.current || v.state.selection.main.empty || activeCell(v)) return false
          e.preventDefault()
          const host = v.dom.getBoundingClientRect()
          setSelMenu({ top: e.clientY - host.top + 8, left: e.clientX - host.left })
          return true
        },
      }),
    [],
  )
  const lastSel = useRef('')
  const onSelection = useCallback((s: SelectionInfo | null) => {
    setSelection(s)
    const key = s ? s.from + ':' + s.to : ''
    if (key !== lastSel.current) setSelMenu(null)
    lastSel.current = key
  }, [])
  useEffect(() => {
    if (!selMenu) return
    // Escape closes the menu and keeps the selection, which the editor would drop.
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setSelMenu(null)
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [selMenu])
  const editorExtensions = useMemo(
    () => [
      formatKeymap({ onComment: commentOn, onLink: openLink }),
      threadDecorations((id) => {
        setActiveThread(id)
        setCommentsOpen(true)
      }),
      selectionListener(onSelection),
      selectionMenu,
      linkCards,
      noteLinkCompletion(searchNotes, () => aliasRef.current, (a) => noteInfo(a).then((i) => i?.headings ?? [])),
      mentionsEnabled
        ? mentions(
            (q) => searchPeople(q, aliasRef.current),
            (p) => noAccessRef.current(p),
          )
        : [],
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
      canEditText.of(() => canEditRef.current),
      tableMenu.of(setTableMenuReq),
      linkOpener.of((url) => openTargetRef.current(url)),
      linkEditor.of((v) => openLink(v)),
      CMView.updateListener.of((u) => {
        if (u.selectionSet || u.docChanged) formatSink.current?.(u.state)
      }),
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
    [commentOn, openLink, onSelection, selectionMenu, linkCards, mentionsEnabled],
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

  const setWide = (wide: boolean) => {
    if (!session) return
    const edit = widthEdit(session.text.toString(), wide)
    if (!edit) return
    session.doc.transact(() => {
      session.text.delete(edit.from, edit.to - edit.from)
      if (edit.insert) session.text.insert(edit.from, edit.insert)
    })
  }

  const startSuggest = (from: number, to: number) => {
    if (!session) return
    const original = session.text.toString().slice(from, to)
    setSuggestDraft({ from, to, original, proposed: original, ...anchorRange(session.text, from, to) })
  }

  const startComment = () => {
    setSelMenu(null)
    if (selection) commentOn(selection.from, selection.to)
  }
  const commentSelection = () => {
    const v = viewRef.current
    const sel = v?.state.selection.main
    if (sel && !sel.empty) commentOn(sel.from, sel.to)
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
    () => (showAuthors && session ? attribution(session.text, refreshClients, !!me?.local_mode) : []),
    [showAuthors, session, refreshClients, me?.local_mode],
  )

  useEffect(() => {
    if (showAuthors) loadClients()
  }, [showAuthors, loadClients])

  const legend = useMemo(() => {
    const seen = new Map<string, { name: string; color: string; sources: Set<string> }>()
    for (const c of clients) {
      const key = personSeed(c.user_id, c.display_name, !!me?.local_mode)
      const e = seen.get(key) ?? { name: c.display_name || 'Unknown', color: personColor(key), sources: new Set<string>() }
      if (c.source !== 'human') e.sources.add(sourceLabel[c.source])
      seen.set(key, e)
    }
    return [...seen.values()]
  }, [clients, me?.local_mode])

  const onView = useCallback(
    (v: EditorView | null) => {
      editorCleanup.current?.()
      editorCleanup.current = undefined
      viewRef.current = v
      setView(v)
      if (!v) return
      v.scrollDOM.addEventListener('scroll', onEditorScroll, { passive: true })
      const stop = scrollSource(v.dom, () => (source.current = 'editor'))
      // A newly shown editor opens at the reading position.
      const restore = position.current
      requestAnimationFrame(() => scrollEditorToLine(v, restore))
      editorCleanup.current = () => {
        v.scrollDOM.removeEventListener('scroll', onEditorScroll)
        stop()
      }
    },
    [onEditorScroll],
  )

  const duplicateThis = async () => {
    try {
      const copy = await duplicateNote(note?.alias ?? alias)
      toast.success('Duplicated')
      navigate('/n/' + copy.alias)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

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
            <Link to="/">Back to documents</Link>
          </Button>
        </div>
      </div>
    )
  }
  if (!note) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    )
  }
  // Until the live copy arrives, the page shows the note's text from the first request. The same page stays
  // once it arrives, so the preview does not render again.
  const ready = Boolean(session && loaded)
  const shown = ready ? text : (note.content ?? '')
  shownLines.current = shown.split('\n').length
  const width = docWidth(shown)

  const showEditor = mode !== 'view' && atLeast(level, 'comment')
  const showPreview = (mode !== 'edit' && mode !== 'live') || !atLeast(level, 'comment')

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col" style={{ '--doc-width': `${docWidthPx[width]}px` } as React.CSSProperties}>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <Link
            to={note?.folder ? '/f/' + note.folder.id : '/'}
            className="flex items-center"
            aria-label={note?.folder ? 'Back to ' + note.folder.name : 'All documents'}
            title={note?.folder ? 'Back to ' + note.folder.name : undefined}
          >
            <Logo className="h-5 text-foreground" />
          </Link>
          <h1 className="min-w-0 truncate px-1 text-sm font-medium" data-testid="note-title">
            {title}
          </h1>
          <span
            className={cn('size-2 shrink-0 rounded-full', connected && synced ? 'bg-emerald-500' : 'bg-amber-500', !ready && 'animate-pulse')}
            title={connected ? (synced ? 'Connected' : 'Syncing') : 'Offline, reconnecting'}
          />
          {!ready && (
            <span className="hidden text-xs text-muted-foreground sm:inline" data-testid="connecting">
              {connected ? 'Loading the live copy…' : 'Connecting…'}
            </span>
          )}
          {!canEdit && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {level === 'comment' ? 'Suggesting' : 'Read only'}
            </span>
          )}
          <div className="flex-1" />
          <div className="mr-1 hidden -space-x-1.5 sm:flex" data-testid="presence">
            {presence.slice(0, 6).map((u) => (
              <Tooltip key={u.clientId}>
                <TooltipTrigger asChild>
                  <span className="flex rounded-full border-2 border-background">
                    <PersonAvatar id={u.id} name={u.name} title="" />
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
          {isSlides(shown) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Present" asChild>
                  <a href={withShare(`/p/${note.alias}`)} target="_blank" rel="noreferrer">
                    <Presentation className="size-4" />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Present the slides</TooltipContent>
            </Tooltip>
          )}
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
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={() => setTimelineOpen(true)}>
                <History className="size-4" /> Timeline
              </DropdownMenuItem>
              {atLeast(level, 'comment') && (
                <>
                  <DropdownMenuCheckboxItem
                    checked={showAuthors}
                    onCheckedChange={(on) => {
                      setShowAuthors(Boolean(on))
                      if (on && mode === 'view') setMode(defaultEditMode)
                    }}
                  >
                    Who wrote what
                  </DropdownMenuCheckboxItem>
                  {canEdit && ready && (
                    <DropdownMenuCheckboxItem checked={width === 'wide'} onCheckedChange={(on) => setWide(Boolean(on))}>
                      Wide layout
                    </DropdownMenuCheckboxItem>
                  )}
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
              {isOwner && (
                <DropdownMenuItem onSelect={() => setAddressOpen(true)}>
                  <Link2 className="size-4" /> Address
                </DropdownMenuItem>
              )}
              {me?.authenticated && (
                <DropdownMenuItem onSelect={duplicateThis}>
                  <Copy className="size-4" /> Duplicate this document
                </DropdownMenuItem>
              )}
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
              <DropdownMenuItem asChild>
                <a href={withShare(`/api/notes/${note.alias}/export.zip`)}>
                  <FileArchive className="size-4" /> Download with uploads (.zip)
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="note-info">
                {note.view_count} {note.view_count === 1 ? 'view' : 'views'} · created {shortDateTime(note.created_at)}
                {note.owner && <div>Owner: {note.owner.display_name || note.owner.username}</div>}
              </div>
              <DropdownMenuItem asChild>
                <Link to={'/audit?note=' + note.alias}>
                  <ScrollText className="size-4" /> Audit log of this document
                </Link>
              </DropdownMenuItem>
              {(isOwner || me?.admin) && (
                <DropdownMenuItem className="text-destructive" onSelect={trashNote}>
                  <Trash2 className="size-4" /> Move to trash
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <NotificationBell />
          <UserMenu />
        </header>
        <main className="flex min-h-0 flex-1">
          {showEditor && (
            <section className={cn('relative flex min-w-0 flex-col border-r', showPreview ? 'w-1/2' : 'w-full')}>
              {canEdit && ready && (
                <FormatToolbar
                  view={view}
                  alias={note.alias}
                  sink={formatSink}
                  onLink={openLink}
                  onComment={commentSelection}
                  searchNotes={searchNotes}
                  undoManager={undoManager}
                />
              )}
              <div className="relative min-h-0 flex-1">
                {selection && atLeast(level, 'comment') && (!canEdit || selMenu) && (
                  <SelectionToolbar
                    top={selMenu?.top ?? selection.top}
                    left={selMenu?.left ?? selection.left}
                    onComment={startComment}
                    onSuggest={() => {
                      setSelMenu(null)
                      startSuggest(selection.from, selection.to)
                    }}
                  >
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
                  </SelectionToolbar>
                )}
                {suggestDraft && note && (
                  <SuggestComposer
                    alias={note.alias}
                    draft={suggestDraft}
                    top={viewRef.current?.coordsAtPos(suggestDraft.to) ? viewRef.current.coordsAtPos(suggestDraft.to)!.bottom - viewRef.current.dom.getBoundingClientRect().top + 8 : 40}
                    onChange={(proposed) => setSuggestDraft({ ...suggestDraft, proposed })}
                    onNoAccess={onNoAccess}
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
                {linkCard && !linkEdit && view && (
                  <LinkCard
                    {...linkCard}
                    onOpen={(info) => openTarget(info.url)}
                    onEdit={canEdit && linkCard.info.editable ? () => openLink(view) : undefined}
                    onRemove={
                      canEdit && linkCard.info.editable
                        ? () => {
                            const l = linkAt(view.state)
                            if (l) view.dispatch(linkChange(view.state, l.text, ''))
                          }
                        : undefined
                    }
                  />
                )}
                {linkEdit && view && <LinkPopover view={view} target={linkEdit} onClose={() => setLinkEdit(null)} />}
                {tableMenuReq && <TableMenu request={tableMenuReq} onClose={() => setTableMenuReq(null)} />}
                {session && ready ? (
                  <CodeEditor
                    ytext={session.text}
                    awareness={session.provider.awareness}
                    readOnly={!atLeast(level, 'comment')}
                    overlay={authorsOverlay}
                    live={mode === 'live'}
                    liveStyle={me?.prefs?.live_style ?? defaultLiveStyle}
                    undoManager={undoManager ?? undefined}
                    extensions={editorExtensions}
                    onView={onView}
                    autoFocus
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-testid="editor-connecting">
                    {connected ? 'Loading the live copy…' : 'Connecting…'}
                  </div>
                )}
              </div>
            </section>
          )}
          {showPreview && (
            <section
              ref={(el) => {
                previewPane.current = el
                setPreviewEl(el)
              }}
              className={cn('relative min-w-0 overflow-y-auto bg-background', showEditor ? 'w-1/2' : 'w-full')}
            >
              {previewSel && commentInPreview && !suggestDraft && (
                <SelectionToolbar
                  top={previewSel.top}
                  left={previewSel.left}
                  onComment={() => commentOn(previewSel.from, previewSel.to, previewSel.quote)}
                  onSuggest={() => {
                    setSuggestTop(previewSel.bottom + 8)
                    startSuggest(previewSel.from, previewSel.to)
                  }}
                />
              )}
              {suggestDraft && !showEditor && (
                <SuggestComposer
                  alias={note.alias}
                  draft={suggestDraft}
                  top={suggestTop}
                  onChange={(proposed) => setSuggestDraft({ ...suggestDraft, proposed })}
                  onDone={(created) => {
                    setSuggestDraft(null)
                    if (created) loadSuggestions()
                  }}
                />
              )}
              <WithToc show={!showEditor && !commentsOpen} scroller={previewEl} width={width} inset={32}>
                <div className="px-8 py-8">
                  <Preview source={shown} ref={article} followHash onRendered={onPreviewRendered} onToggleTask={canEdit && ready ? toggleTask : undefined} />
                </div>
              </WithToc>
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
              onNoAccess={onNoAccess}
            />
          )}
        </main>
        <ShareDialog alias={note.alias} isOwner={isOwner} open={shareOpen} onOpenChange={setShareOpen} />
        {isOwner && <AddressDialog note={note} open={addressOpen} onOpenChange={setAddressOpen} onChanged={applyAlias} />}
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
