import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Folder, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { AppHeader } from '@/components/AppHeader'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { loginHref, useMe } from '@/lib/me'
import { relativeTime, shortDateTime } from '@/lib/time'

interface Trashed {
  id: string
  alias: string
  title: string
  owner: string
  deleted_at: string
  deleted_by: string
}

interface TrashedFolder {
  id: string
  name: string
  owner: string
  deleted_at: string
  deleted_by: string
  notes: number
}

export default function Trash() {
  const { me } = useMe()
  const navigate = useNavigate()
  const [notes, setNotes] = useState<Trashed[] | null>(null)
  const [folders, setFolders] = useState<TrashedFolder[]>([])
  const [days, setDays] = useState(30)
  const load = () =>
    api.get<{ notes: Trashed[]; folders: TrashedFolder[]; retention_days: number }>('/api/trash').then((r) => {
      setNotes(r.notes)
      setFolders(r.folders ?? [])
      setDays(r.retention_days)
    })
  useEffect(() => {
    if (me?.authenticated) load()
  }, [me])
  if (me && !me.authenticated) {
    location.href = loginHref()
    return null
  }

  const restore = async (n: Trashed) => {
    try {
      await api.post(`/api/notes/${n.alias}/restore`)
      toast.success('Restored', { action: { label: 'Open', onClick: () => navigate('/n/' + n.alias) } })
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const destroy = async (n: Trashed) => {
    if (!confirm(`Delete “${n.title || n.alias}” for good? Its history, comments and uploads go too. This cannot be undone.`)) return
    try {
      await api.del(`/api/notes/${n.alias}?permanent=1`)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const restoreFolder = async (f: TrashedFolder) => {
    try {
      await api.post(`/api/folders/${f.id}/restore`)
      toast.success('Restored', { action: { label: 'Open', onClick: () => navigate('/f/' + f.id) } })
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const destroyFolder = async (f: TrashedFolder) => {
    if (!confirm(`Delete the folder “${f.name}” and its ${f.notes} document(s) for good? This cannot be undone.`)) return
    try {
      await api.del(`/api/folders/${f.id}?permanent=1`)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Trash</h1>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">
          Documents stay here for {days} days, then they are deleted for good. The <Link to="/audit" className="underline">audit log</Link> keeps a record.
        </p>
        {folders.length > 0 && (
          <ul className="mb-4 flex flex-col divide-y rounded-lg border bg-card" data-testid="trash-folders">
            {folders.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-4 py-3">
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{f.name}</div>
                  <div className="text-xs text-muted-foreground" title={shortDateTime(f.deleted_at)}>
                    Folder with {f.notes} {f.notes === 1 ? 'document' : 'documents'} · moved to the trash {relativeTime(f.deleted_at)}
                    {f.deleted_by ? ` by ${f.deleted_by}` : ''}
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => restoreFolder(f)}>
                  <RotateCcw className="size-3.5" /> Restore
                </Button>
                <Button size="icon" variant="ghost" aria-label="Delete for good" onClick={() => destroyFolder(f)}>
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {notes?.length === 0 && folders.length === 0 && <p className="rounded-lg border border-dashed py-12 text-center text-muted-foreground">The trash is empty.</p>}
        <ul className="flex flex-col divide-y rounded-lg border bg-card" data-testid="trash-list">
          {notes?.map((n) => (
            <li key={n.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{n.title || n.alias}</div>
                <div className="text-xs text-muted-foreground" title={shortDateTime(n.deleted_at)}>
                  Moved to the trash {relativeTime(n.deleted_at)}
                  {n.deleted_by ? ` by ${n.deleted_by}` : ''}
                  {n.owner ? ` · owner ${n.owner}` : ''}
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => restore(n)}>
                <RotateCcw className="size-3.5" /> Restore
              </Button>
              <Button size="icon" variant="ghost" aria-label="Delete for good" onClick={() => destroy(n)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
