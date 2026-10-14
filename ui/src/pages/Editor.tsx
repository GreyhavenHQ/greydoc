import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { EditorView } from '@codemirror/view'
import {
  Columns2,
  Download,
  Eye,
  FileCode,
  MoreHorizontal,
  Pencil,
  Presentation,
  Share2,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Logo } from '@/components/Logo'
import { ThemeToggle, UserMenu } from '@/components/AppHeader'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Spinner } from '@/components/ui/spinner'
import { ShareDialog } from '@/components/ShareDialog'
import { CodeEditor } from '@/editor/CodeEditor'
import { NoteSession, type AppEvent } from '@/editor/session'
import { Preview, scrollToSourceLine } from '@/render/Preview'
import { api, ApiError, atLeast, shareParam, withShare, type Level, type Note } from '@/lib/api'
import { loginHref, useMe } from '@/lib/me'
import { localName, presenceColor } from '@/lib/presence'
import { extractTitle } from '@/lib/meta'
import { cn } from '@/lib/utils'

type Mode = 'edit' | 'both' | 'view'

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
  const [level, setLevel] = useState<Level>('read')
  const [mode, setMode] = useState<Mode>('both')
  const [session, setSession] = useState<NoteSession | null>(null)
  const [synced, setSynced] = useState(false)
  const [connected, setConnected] = useState(true)
  const [shareOpen, setShareOpen] = useState(false)
  const viewRef = useRef<EditorView | null>(null)
  const previewPane = useRef<HTMLElement | null>(null)
  const article = useRef<HTMLElement | null>(null)
  const text = useYText(session)
  const presence = usePresence(session)

  useEffect(() => {
    setNote(null)
    setError('')
    api
      .get<Note>(withShare(`/api/notes/${alias}?visit=1`))
      .then((n) => {
        setNote(n)
        setLevel(n.level)
        if (!atLeast(n.level, 'comment')) setMode('view')
        if (n.alias !== alias) navigate('/n/' + n.alias + location.search, { replace: true })
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          location.href = loginHref()
          return
        }
        setError(e instanceof ApiError && e.status === 404 ? 'This note does not exist.' : e instanceof Error ? e.message : String(e))
      })
  }, [alias, navigate])

  useEffect(() => {
    if (!note || !me) return
    const s = new NoteSession(note.alias, { name: me.local_mode ? localName() : undefined, share: shareParam() })
    s.setUser({ name: me.local_mode ? localName() : me.display_name || me.username || 'guest', color: presenceColor() })
    const onSync = (v: boolean) => setSynced(v)
    const onStatus = (e: { status: string }) => setConnected(e.status === 'connected')
    s.provider.on('sync', onSync)
    s.provider.on('status', onStatus)
    const off = s.onEvent((ev: AppEvent) => {
      if (ev.type === 'access' && ev.level) {
        setLevel(ev.level)
        if (ev.level === 'deny') toast.error('Your access to this note was removed.')
      }
      if (ev.type === 'deleted') {
        toast.error('This note was deleted.')
        navigate('/')
      }
    })
    setSession(s)
    return () => {
      off()
      s.provider.off('sync', onSync)
      s.provider.off('status', onStatus)
      s.destroy()
      setSession(null)
      setSynced(false)
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
      const next = ({ e: 'edit', b: 'both', v: 'view' } as Record<string, Mode>)[e.key.toLowerCase()]
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

  const onView = useCallback(
    (v: EditorView | null) => {
      viewRef.current = v
      v?.scrollDOM.addEventListener('scroll', syncScroll, { passive: true })
    },
    [syncScroll],
  )

  const deleteNote = async () => {
    if (!confirm('Delete this note for everyone? This cannot be undone.')) return
    await api.del('/api/notes/' + alias)
    navigate('/')
  }

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">{error}</p>
        <Button asChild variant="outline">
          <Link to="/">Back to notes</Link>
        </Button>
      </div>
    )
  }
  if (!note || !session) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    )
  }

  const showEditor = mode !== 'view' && atLeast(level, 'comment')
  const showPreview = mode !== 'edit' || !atLeast(level, 'comment')

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
          {me?.authenticated && (
            <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
              <Share2 className="size-4" /> Share
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
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
              {isOwner && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onSelect={deleteNote}>
                    <Trash2 className="size-4" /> Delete note
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <ThemeToggle />
          <UserMenu />
        </header>
        <main className="flex min-h-0 flex-1">
          {showEditor && (
            <section className={cn('min-w-0 border-r', showPreview ? 'w-1/2' : 'w-full')}>
              <CodeEditor
                ytext={session.text}
                awareness={session.provider.awareness}
                readOnly={!canEdit}
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
                <Preview source={text} ref={article} />
              </div>
            </section>
          )}
        </main>
        <ShareDialog alias={note.alias} isOwner={isOwner} open={shareOpen} onOpenChange={setShareOpen} />
      </div>
    </TooltipProvider>
  )
}
