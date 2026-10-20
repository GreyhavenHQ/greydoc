import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  FileUp,
  Folder,
  FolderInput,
  FolderPlus,
  Menu,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Presentation,
  Search,
  Share2,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import { AppHeader } from '@/components/AppHeader'
import { Sidebar, type Scope } from '@/components/Sidebar'
import { MoveDialog } from '@/components/MoveDialog'
import { ShareDialog } from '@/components/ShareDialog'
import { SignInCard } from '@/pages/Login'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api, atLeast, noteTitle, type FolderSummary, type FolderView, type NoteSummary, type TagCount } from '@/lib/api'
import { folderKey, noteKey, splitSelection } from '@/lib/folders'
import { useMe } from '@/lib/me'
import { importFiles, isImportable } from '@/lib/importNotes'
import { relativeTime } from '@/lib/time'
import { PersonAvatar } from '@/components/PersonAvatar'
import { cn } from '@/lib/utils'

const scopeTitles: Record<Scope, string> = { recent: 'Recent', mine: 'My documents', shared: 'Shared with me', all: 'All documents' }

export default function Home() {
  const { me } = useMe()
  const { folderId } = useParams()
  const [params, setParams] = useSearchParams()
  const scope: Scope = (params.get('scope') as Scope) || 'recent'
  const tag = params.get('tag') ?? ''
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [notes, setNotes] = useState<NoteSummary[] | null>(null)
  const [folders, setFolders] = useState<FolderSummary[]>([])
  const [view, setView] = useState<FolderView | null>(null)
  const [tags, setTags] = useState<TagCount[]>([])
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [moveOpen, setMoveOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [nameDialog, setNameDialog] = useState<null | { title: string; value: string; submit: (name: string) => Promise<void> }>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const navigate = useNavigate()
  const refresh = () => setReload((n) => n + 1)
  const drop = useDropImport(refresh, (alias) => navigate('/n/' + alias))
  const local = !!me?.local_mode

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
  }

  const q = params.get('q') ?? ''
  const flat = !!(q || tag)
  const where = flat ? 'search' : folderId ? 'folder' : scope
  useEffect(() => {
    if (!me?.authenticated) return
    setNotes(null)
    setSelected(new Set())
    const list = (sp: Record<string, string>) => api.get<{ notes: NoteSummary[] }>('/api/notes?' + new URLSearchParams(sp)).then((r) => r.notes)
    const fail = (e: unknown) => {
      toast.error(e instanceof Error ? e.message : String(e))
      setNotes([])
    }
    if (flat) {
      const sp: Record<string, string> = { scope: 'all' }
      if (tag) sp.tag = tag
      if (q) sp.q = q
      setFolders([])
      list(sp).then(setNotes, fail)
    } else if (folderId) {
      Promise.all([api.get<FolderView>('/api/folders/' + folderId), list({ scope: 'all', folder: folderId })]).then(([v, ns]) => {
        setView(v)
        setFolders(v.children)
        setNotes(ns)
      }, (e) => {
        setView(null)
        fail(e)
      })
    } else if (scope === 'mine' || scope === 'shared') {
      const sp: Record<string, string> = scope === 'mine' ? { scope: local ? 'all' : 'mine', folder: 'root' } : { scope: 'shared' }
      Promise.all([api.get<{ folders: FolderSummary[] }>('/api/folders?scope=' + scope), list(sp)]).then(([f, ns]) => {
        setFolders(f.folders)
        setNotes(ns)
      }, fail)
    } else {
      setFolders([])
      list({ scope }).then(setNotes, fail)
    }
  }, [me, local, scope, tag, q, flat, folderId, reload])

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

  const toggleSelected = (key: string) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const folder = folderId && view?.folder.id === folderId ? view : null
  const canWrite = folder ? atLeast(folder.level, 'write') : true
  const isFolderOwner = folder ? folder.level === 'full' : false
  const selection = useMemo(() => splitSelection(selected), [selected])

  const createFolder = () =>
    setNameDialog({
      title: 'New folder',
      value: '',
      submit: async (name) => {
        const r = await api.post<{ folder: { id: string } }>('/api/folders', { name, parent: folder?.folder.id ?? '' })
        navigate('/f/' + r.folder.id)
        refresh()
      },
    })
  const renameFolder = () =>
    folder &&
    setNameDialog({
      title: 'Rename folder',
      value: folder.folder.name,
      submit: async (name) => {
        await api.patch('/api/folders/' + folder.folder.id, { name })
        refresh()
      },
    })
  const trashFolder = async () => {
    if (!folder || !confirm(`Move “${folder.folder.name}” and everything in it that you own to the trash?`)) return
    try {
      const r = await api.del<{ trashed: number; moved_out: number }>('/api/folders/' + folder.folder.id)
      toast.success(r.moved_out ? `Moved to the trash. ${r.moved_out} document(s) of other people went back to their owners.` : 'Moved to the trash')
      navigate(folder.path.length ? '/f/' + folder.path[folder.path.length - 1].id : '/?scope=mine')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const trashSelected = async () => {
    const n = selected.size
    if (!confirm(`Move ${n === 1 ? 'this item' : n + ' items'} to the trash? Folders take the documents you own inside them.`)) return
    let failed = 0
    for (const alias of selection.notes) await api.del('/api/notes/' + alias).catch(() => failed++)
    for (const id of selection.folders) await api.del('/api/folders/' + id).catch(() => failed++)
    if (failed) toast.error(`${failed} item(s) could not move to the trash. Only their owner can do that.`)
    else toast.success('Moved to the trash')
    refresh()
  }

  if (me && !me.authenticated) return <SignInCard next="/" />

  const expand = folder ? [...folder.path.map((p) => p.id), folder.folder.id] : []
  const sidebar = (onNavigate?: () => void) => <Sidebar scope={folderId ? undefined : scope} folderId={folderId} expand={expand} reload={reload} onNavigate={onNavigate} />
  const sharedRoot = !!folder && !local && folder.root_owner_id !== me?.id
  const rootLabel = sharedRoot ? scopeTitles.shared : local ? 'Documents' : scopeTitles.mine
  const rootLink = sharedRoot ? '/?scope=shared' : '/?scope=mine'
  const emptyText = flat
    ? 'No documents match.'
    : folderId
      ? 'This folder is empty.'
      : scope === 'recent'
        ? 'Documents you open appear here.'
        : scope === 'shared'
          ? 'Nothing is shared with you yet.'
          : 'No documents yet.'

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
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Folders" onClick={() => setMenuOpen(true)}>
          <Menu className="size-4" />
        </Button>
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
        <Button size="sm" onClick={() => navigate(folder && canWrite ? '/new?folder=' + folder.folder.id : '/new')}>
          <Plus className="size-4" /> New document
        </Button>
      </AppHeader>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72 p-3">
          <SheetTitle className="sr-only">Folders</SheetTitle>
          {sidebar(() => setMenuOpen(false))}
        </SheetContent>
      </Sheet>
      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
        <aside className="hidden w-60 shrink-0 md:block">
          <div className="sticky top-16 max-h-[calc(100vh-5rem)] overflow-y-auto">{sidebar()}</div>
        </aside>
        <main className="min-w-0 flex-1 pb-20">
          <div className="mb-5 flex min-h-9 flex-wrap items-center gap-3">
            {flat ? (
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
            ) : folderId ? (
              <>
                <nav aria-label="Folder path" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-lg" data-testid="breadcrumb">
                  <Link to={rootLink} className="text-muted-foreground hover:text-foreground">
                    {rootLabel}
                  </Link>
                  {folder?.path.map((p) => (
                    <span key={p.id} className="flex items-center gap-1">
                      <ChevronRight className="size-4 text-muted-foreground" />
                      <Link to={'/f/' + p.id} className="text-muted-foreground hover:text-foreground">
                        {p.name}
                      </Link>
                    </span>
                  ))}
                  <ChevronRight className="size-4 text-muted-foreground" />
                  <h1 className="font-semibold tracking-tight">{folder?.folder.name ?? '…'}</h1>
                </nav>
                {folder && (
                  <div className="flex items-center gap-2">
                    {canWrite && (
                      <Button size="sm" variant="outline" onClick={createFolder}>
                        <FolderPlus className="size-4" /> New folder
                      </Button>
                    )}
                    {!local && (
                      <Button size="sm" variant="outline" onClick={() => setShareOpen(true)}>
                        <Share2 className="size-4" /> Share
                      </Button>
                    )}
                    {(canWrite || isFolderOwner) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" aria-label="Folder actions">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={renameFolder}>
                            <Pencil className="size-4" /> Rename
                          </DropdownMenuItem>
                          {isFolderOwner && (
                            <>
                              <DropdownMenuItem
                                onSelect={() => {
                                  setSelected(new Set([folderKey(folder.folder.id)]))
                                  setMoveOpen(true)
                                }}
                              >
                                <FolderInput className="size-4" /> Move
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onSelect={trashFolder} className="text-destructive">
                                <Trash2 className="size-4" /> Move to trash
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <h1 className="flex-1 text-lg font-semibold tracking-tight">{local && scope === 'mine' ? 'Documents' : scopeTitles[scope]}</h1>
                {scope === 'mine' && (
                  <Button size="sm" variant="outline" onClick={createFolder}>
                    <FolderPlus className="size-4" /> New folder
                  </Button>
                )}
              </>
            )}
          </div>

          {tags.length > 0 && !folderId && <TagFilter tags={tags} selected={tag} onSelect={(t) => update({ tag: t })} />}

          {folders.length > 0 && (
            <ul className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="folder-list">
              {folders.map((f) => {
                const key = folderKey(f.id)
                return (
                  <li key={f.id} className="group relative">
                    <Link
                      to={'/f/' + f.id}
                      className={cn(
                        'flex h-full items-center gap-3 rounded-lg border bg-card px-4 py-3 transition-colors hover:border-primary/60',
                        selected.has(key) && 'border-primary bg-primary/5',
                      )}
                    >
                      <Folder className="size-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1 pr-6">
                        <div className="truncate font-medium">{f.name}</div>
                        {f.owner && <div className="truncate text-xs text-muted-foreground">{f.owner}</div>}
                      </div>
                    </Link>
                    <SelectBox checked={selected.has(key)} anySelected={selected.size > 0} label={'Select ' + f.name} onChange={() => toggleSelected(key)} className="top-1/2 -translate-y-1/2" />
                  </li>
                )
              })}
            </ul>
          )}

          {notes === null ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
          ) : notes.length === 0 ? (
            folders.length === 0 && (
              <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed py-16 text-center">
                <FileText className="size-8 text-muted-foreground" />
                <p className="text-muted-foreground">{emptyText}</p>
                {canWrite && (
                  <Button size="lg" onClick={() => navigate(folder ? '/new?folder=' + folder.folder.id : '/new')}>
                    <Plus className="size-4" /> New document
                  </Button>
                )}
              </div>
            )
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="note-list">
              {notes.map((n) => {
                const key = noteKey(n.alias)
                return (
                  <li key={n.id} className="group relative">
                    <Link
                      to={'/n/' + n.alias}
                      className={cn(
                        'flex h-full flex-col gap-2 rounded-lg border bg-card p-4 transition-colors hover:border-primary/60',
                        selected.has(key) && 'border-primary bg-primary/5',
                      )}
                    >
                      <div className={cn('font-medium leading-snug', n.slides ? 'pr-20' : 'pr-14')}>{noteTitle(n)}</div>
                      {(n.snippet || n.description) && <p className="line-clamp-3 text-sm text-muted-foreground">{n.snippet || n.description}</p>}
                      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1 text-xs text-muted-foreground">
                        {n.tags.length === 0 && !n.folder_name && <span className="h-5" />}
                        {n.folder_name && !folderId && (
                          <span
                            role="link"
                            tabIndex={0}
                            onClick={(e) => {
                              e.preventDefault()
                              navigate('/f/' + n.folder_id)
                            }}
                            className="flex items-center gap-1 rounded-md bg-muted/70 px-1.5 py-0.5 text-foreground/80 hover:text-primary"
                            title={'In ' + n.folder_name}
                          >
                            <Folder className="size-3" />
                            {n.folder_name}
                          </span>
                        )}
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
                            <PersonAvatar id={n.owner_id} name={n.owner} size={16} />
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
                    {/* Aligned with the first line of the title: p-4 and the title's leading-snug line height. */}
                    <div className="absolute top-4 right-4 flex h-[1.375rem] items-center gap-2">
                      <button
                        className={cn(
                          'text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-primary focus-visible:opacity-100',
                          n.pinned && 'text-primary opacity-100',
                        )}
                        aria-label={n.pinned ? 'Unpin' : 'Pin'}
                        onClick={() => togglePin(n)}
                      >
                        {n.pinned ? <Pin className="size-4" /> : <PinOff className="size-4" />}
                      </button>
                      {n.slides && (
                        <a
                          href={'/p/' + n.alias}
                          target="_blank"
                          rel="noreferrer"
                          className="text-muted-foreground hover:text-primary"
                          aria-label="Present"
                          title="Present the slides"
                        >
                          <Presentation className="size-4" />
                        </a>
                      )}
                      <SelectBox checked={selected.has(key)} anySelected={selected.size > 0} label={'Select ' + noteTitle(n)} onChange={() => toggleSelected(key)} />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </main>
      </div>

      {selected.size > 0 && !moveOpen && (
        <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4" data-testid="selection-bar">
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-lg">
            <span className="px-1 text-sm font-medium">{selected.size} selected</span>
            <Button size="sm" variant="outline" onClick={() => setMoveOpen(true)}>
              <FolderInput className="size-4" /> Move
            </Button>
            <Button size="sm" variant="outline" onClick={trashSelected}>
              <Trash2 className="size-4" /> Move to trash
            </Button>
            <Button size="icon" variant="ghost" aria-label="Clear selection" onClick={() => setSelected(new Set())}>
              <X className="size-4" />
            </Button>
          </div>
        </div>
      )}
      <MoveDialog
        open={moveOpen}
        onOpenChange={(o) => {
          setMoveOpen(o)
          if (!o && folderId && selection.folders.includes(folderId) && selection.notes.length === 0 && selected.size === 1) setSelected(new Set())
        }}
        notes={selection.notes}
        folders={selection.folders}
        onMoved={refresh}
      />
      {folder && <ShareDialog folderId={folder.folder.id} isOwner={isFolderOwner} open={shareOpen} onOpenChange={(o) => { setShareOpen(o); if (!o) refresh() }} />}
      <NameDialog state={nameDialog} onClose={() => setNameDialog(null)} />
    </div>
  )
}

function SelectBox({ checked, anySelected, label, onChange, className }: { checked: boolean; anySelected: boolean; label: string; onChange: () => void; className?: string }) {
  return (
    <Checkbox
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className={cn(
        'bg-background transition-opacity',
        className && 'absolute right-4',
        className,
        checked || anySelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
      )}
    />
  )
}

function NameDialog({ state, onClose }: { state: null | { title: string; value: string; submit: (name: string) => Promise<void> }; onClose: () => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (state) setName(state.value)
  }, [state])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!state || !name.trim()) return
    setBusy(true)
    try {
      await state.submit(name.trim())
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{state?.title}</DialogTitle>
          </DialogHeader>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Folder name" aria-label="Folder name" autoFocus maxLength={200} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
