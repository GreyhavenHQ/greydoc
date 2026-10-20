import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Clock, Files, HardDrive, Trash2, Users } from 'lucide-react'
import { FolderTree, useOpenFolders } from '@/components/FolderTree'
import { api, type FolderSummary } from '@/lib/api'
import { useMe } from '@/lib/me'
import { cn } from '@/lib/utils'

export type Scope = 'recent' | 'mine' | 'shared' | 'all'

interface SidebarProps {
  scope?: Scope
  folderId?: string
  // expand opens these folders, for example the path to the current one.
  expand?: string[]
  reload?: number
  onNavigate?: () => void
}

export function Sidebar({ scope, folderId, expand = [], reload, onNavigate }: SidebarProps) {
  const { me } = useMe()
  const navigate = useNavigate()
  const [mine, setMine] = useState<FolderSummary[]>([])
  const [shared, setShared] = useState<FolderSummary[]>([])
  const { open, toggle } = useOpenFolders(expand)
  const local = !!me?.local_mode

  useEffect(() => {
    if (!me?.authenticated) return
    api.get<{ folders: FolderSummary[] }>('/api/folders?scope=mine').then((r) => setMine(r.folders))
    if (!local) api.get<{ folders: FolderSummary[] }>('/api/folders?scope=shared').then((r) => setShared(r.folders))
  }, [me, local, reload])

  const go = (f: FolderSummary) => {
    navigate('/f/' + f.id)
    onNavigate?.()
  }
  const item = (to: string, active: boolean, icon: React.ReactNode, label: string) => (
    <Link
      to={to}
      onClick={onNavigate}
      className={cn('flex h-8 items-center gap-2 rounded-md px-2 text-sm', active ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted')}
    >
      {icon}
      {label}
    </Link>
  )

  return (
    <nav className="flex flex-col gap-0.5" aria-label="Documents and folders" data-testid="sidebar">
      {item('/', !folderId && scope === 'recent', <Clock className="size-4" />, 'Recent')}
      {item('/?scope=mine', !folderId && scope === 'mine', <HardDrive className="size-4" />, local ? 'Documents' : 'My documents')}
      {mine.length > 0 && (
        <div className="mb-1 pl-2">
          <FolderTree folders={mine} selected={folderId} onSelect={go} open={open} toggle={toggle} reload={reload} />
        </div>
      )}
      {!local && item('/?scope=shared', !folderId && scope === 'shared', <Users className="size-4" />, 'Shared with me')}
      {shared.length > 0 && (
        <div className="mb-1 pl-2">
          <FolderTree folders={shared} selected={folderId} onSelect={go} open={open} toggle={toggle} reload={reload} />
        </div>
      )}
      {item('/?scope=all', !folderId && scope === 'all', <Files className="size-4" />, local ? 'All documents' : 'All')}
      {item('/trash', false, <Trash2 className="size-4" />, 'Trash')}
    </nav>
  )
}
