import { useEffect, useState } from 'react'
import { ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { api, type FolderSummary, type FolderView } from '@/lib/api'
import { cn } from '@/lib/utils'

const storageKey = 'greydoc.folders.open'

function loadOpen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

// useOpenFolders keeps which tree nodes are expanded, across pages and reloads.
export function useOpenFolders(expand: string[]) {
  const [open, setOpen] = useState<Set<string>>(loadOpen)
  const expandKey = expand.join(',')
  useEffect(() => {
    if (!expandKey) return
    setOpen((cur) => {
      const ids = expandKey.split(',')
      if (ids.every((id) => cur.has(id))) return cur
      return new Set([...cur, ...ids])
    })
  }, [expandKey])
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify([...open].slice(-200)))
  }, [open])
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return { open, toggle }
}

interface TreeProps {
  folders: FolderSummary[]
  selected?: string
  onSelect: (f: FolderSummary) => void
  open: Set<string>
  toggle: (id: string) => void
  reload?: number
  // disabled folders cannot be chosen, for example the folder being moved.
  disabled?: Set<string>
  depth?: number
}

export function FolderTree({ folders, depth = 0, ...props }: TreeProps) {
  return (
    <ul role={depth === 0 ? 'tree' : 'group'} className="flex flex-col">
      {folders.map((f) => (
        <FolderNode key={f.id} folder={f} depth={depth} {...props} />
      ))}
    </ul>
  )
}

function FolderNode({ folder, depth, selected, onSelect, open, toggle, reload, disabled }: Omit<TreeProps, 'folders'> & { folder: FolderSummary; depth: number }) {
  const expanded = open.has(folder.id)
  const [children, setChildren] = useState<FolderSummary[] | null>(null)
  useEffect(() => {
    if (!expanded) return
    let live = true
    api
      .get<FolderView>('/api/folders/' + folder.id)
      .then((v) => live && setChildren(v.children))
      .catch(() => live && setChildren([]))
    return () => {
      live = false
    }
  }, [expanded, folder.id, reload])
  const off = disabled?.has(folder.id)
  const hasChildren = children ? children.length > 0 : folder.has_children
  return (
    <li role="treeitem" aria-expanded={hasChildren ? expanded : undefined} aria-selected={selected === folder.id}>
      <div
        className={cn(
          'group flex h-7 items-center gap-1 rounded-md pr-2 text-sm',
          selected === folder.id ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted',
          off && 'opacity-50',
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        <button
          type="button"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className={cn('flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground', !hasChildren && 'invisible')}
          onClick={() => toggle(folder.id)}
        >
          <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
        </button>
        <button type="button" disabled={off} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => onSelect(folder)} title={folder.name}>
          {expanded ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />}
          <span className="truncate">{folder.name}</span>
        </button>
      </div>
      {expanded && children && children.length > 0 && (
        <FolderTree folders={children} depth={depth + 1} selected={selected} onSelect={onSelect} open={open} toggle={toggle} reload={reload} disabled={disabled} />
      )}
    </li>
  )
}
