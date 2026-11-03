import { useEffect, useState, type FormEvent } from 'react'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, setSlug, type Note } from '@/lib/api'

const errorText: Record<string, string> = {
  alias_taken: 'Another document uses this address.',
  alias_forbidden: 'This address is not allowed. Use 1 to 64 letters, digits, - or _, and not a reserved word or a document id.',
}

interface AddressDialogProps {
  note: Note
  open: boolean
  onOpenChange: (o: boolean) => void
  onChanged: (alias: string, aliases: Note['aliases']) => void
}

export function AddressDialog({ note, open, onOpenChange, onChanged }: AddressDialogProps) {
  const [slug, setSlugValue] = useState(note.alias)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const idURL = `${location.origin}/n/${note.id}`

  useEffect(() => {
    if (!open) return
    setSlugValue(note.alias)
    setError('')
  }, [open, note.alias])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await setSlug(note.id, slug)
      onChanged(r.alias, r.aliases)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof ApiError ? (errorText[err.code] ?? err.message) : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Address</DialogTitle>
          <DialogDescription>The id address always opens this document. A new custom address replaces the previous one, which stops working.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Permanent address</div>
          <div className="flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" data-testid="id-address">
              {idURL}
            </code>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Copy permanent address"
              onClick={() => navigator.clipboard?.writeText(idURL).then(() => toast.success('Copied'))}
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </div>
        <form onSubmit={save} className="space-y-2">
          <Label htmlFor="note-slug">Custom address</Label>
          <div className="flex items-center gap-1 text-sm">
            <span className="text-muted-foreground">/n/</span>
            <Input id="note-slug" value={slug} onChange={(e) => setSlugValue(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={busy || !slug.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
