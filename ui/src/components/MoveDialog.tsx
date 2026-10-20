import { useEffect, useMemo, useState } from 'react'
import { HardDrive } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { FolderTree, useOpenFolders } from '@/components/FolderTree'
import { api, type FolderSummary } from '@/lib/api'
import { summarizeChanges, type AccessChange, type ChangeLine } from '@/lib/folders'
import { useMe } from '@/lib/me'
import { cn } from '@/lib/utils'

const levelWords: Record<string, string> = { deny: 'no access', read: 'can view', comment: 'can comment', write: 'can edit', full: 'owner' }

// ROOT stands for the top level, outside any folder.
const ROOT = ''

interface MoveDialogProps {
  open: boolean
  onOpenChange: (o: boolean) => void
  notes: string[]
  folders: string[]
  onMoved: () => void
}

export function MoveDialog({ open, onOpenChange, notes, folders, onMoved }: MoveDialogProps) {
  const { me } = useMe()
  const [mine, setMine] = useState<FolderSummary[]>([])
  const [shared, setShared] = useState<FolderSummary[]>([])
  const [dest, setDest] = useState<{ id: string; name: string } | null>(null)
  const [changes, setChanges] = useState<AccessChange[] | null>(null)
  const [busy, setBusy] = useState(false)
  const { open: openNodes, toggle } = useOpenFolders([])
  const moving = useMemo(() => new Set(folders), [folders])
  const count = notes.length + folders.length

  useEffect(() => {
    if (!open) return
    setDest(null)
    setChanges(null)
    api.get<{ folders: FolderSummary[] }>('/api/folders?scope=mine').then((r) => setMine(r.folders))
    if (!me?.local_mode) api.get<{ folders: FolderSummary[] }>('/api/folders?scope=shared').then((r) => setShared(r.folders))
  }, [open, me])

  useEffect(() => {
    if (!dest) return
    setChanges(null)
    api
      .post<{ changes: AccessChange[] }>('/api/move', { notes, folders, to: dest.id, dry_run: true })
      .then((r) => setChanges(r.changes))
      .catch((e: unknown) => {
        toast.error(e instanceof Error ? e.message : String(e))
        setDest(null)
      })
  }, [dest, notes, folders])

  const confirm = async () => {
    if (!dest) return
    setBusy(true)
    try {
      await api.post('/api/move', { notes, folders, to: dest.id })
      toast.success(`Moved ${count === 1 ? '1 item' : count + ' items'} to ${dest.name}`)
      onOpenChange(false)
      onMoved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const summary = changes ? summarizeChanges(changes) : null
  const pick = (f: FolderSummary) => setDest({ id: f.id, name: f.name })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move {count === 1 ? '1 item' : count + ' items'}</DialogTitle>
          <DialogDescription>Items keep their own sharing. They lose the access of their old folder and get the access of the new one.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-72 flex-col overflow-y-auto rounded-md border p-1" data-testid="move-targets">
          <button
            type="button"
            className={cn('flex h-7 items-center gap-1.5 rounded-md px-2 text-left text-sm', dest?.id === ROOT ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted')}
            onClick={() => setDest({ id: ROOT, name: me?.local_mode ? 'Documents' : 'My documents' })}
          >
            <HardDrive className="size-4 text-muted-foreground" /> {me?.local_mode ? 'Documents (top level)' : 'My documents (top level)'}
          </button>
          <FolderTree folders={mine} selected={dest?.id} onSelect={pick} open={openNodes} toggle={toggle} disabled={moving} />
          {shared.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">Shared with me</div>
              <FolderTree folders={shared} selected={dest?.id} onSelect={pick} open={openNodes} toggle={toggle} disabled={moving} />
            </>
          )}
        </div>
        {dest && (
          <div className="text-sm" data-testid="move-changes">
            {!summary ? (
              <p className="text-muted-foreground">Checking who has access…</p>
            ) : summary.lost.length === 0 && summary.gained.length === 0 ? (
              <p className="text-muted-foreground">Nobody gains or loses access.</p>
            ) : (
              <div className="flex flex-col gap-2">
                <ChangeList title="Loses access" lines={summary.lost} tone="text-destructive" />
                <ChangeList title="Gains access" lines={summary.gained} tone="text-primary" />
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!dest || !changes || busy} onClick={confirm}>
            Move to {dest?.name ?? '…'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChangeList({ title, lines, tone }: { title: string; lines: ChangeLine[]; tone: string }) {
  if (lines.length === 0) return null
  return (
    <div>
      <div className={cn('mb-1 text-xs font-medium', tone)}>{title}</div>
      <ul className="flex flex-col gap-0.5">
        {lines.map((l) => (
          <li key={l.who + l.before + l.after}>
            <span className="font-medium">{l.who}</span>: {levelWords[l.before]} → {levelWords[l.after]}
            <span className="text-muted-foreground"> · {l.items.length === 1 ? l.items[0] : l.items.length + ' items'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
