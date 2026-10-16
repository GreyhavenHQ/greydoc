import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { MentionTextarea } from '@/components/Mentions'
import type { Person } from '@/lib/mentions'
import { api, withShare } from '@/lib/api'

export interface SuggestDraft {
  from: number
  to: number
  original: string
  proposed: string
  anchor_start: string
  anchor_end: string
}

// SuggestComposer edits a proposed replacement for the selected text before it is sent.
export function SuggestComposer({
  alias,
  draft,
  top,
  onChange,
  onDone,
  onNoAccess,
}: {
  alias: string
  draft: SuggestDraft
  top: number
  onChange: (proposed: string) => void
  onDone: (created: boolean) => void
  onNoAccess?: (p: Person) => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      await api.post(withShare(`/api/notes/${alias}/suggestions`), {
        anchor_start: draft.anchor_start,
        anchor_end: draft.anchor_end,
        original: draft.original,
        proposed: draft.proposed,
        reason,
      })
      toast.success('Suggestion sent')
      onDone(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="absolute right-4 left-12 z-30 rounded-lg border bg-popover p-3 shadow-lg"
      style={{ top: Math.max(8, top) }}
      data-testid="suggest-composer"
    >
      <div className="mb-1 text-xs font-medium text-muted-foreground">Suggest a change</div>
      {draft.original && (
        <div className="mb-2 max-h-24 overflow-auto rounded bg-red-500/10 px-2 py-1 font-mono text-xs whitespace-pre-wrap line-through decoration-red-500/60">
          {draft.original}
        </div>
      )}
      <MentionTextarea
        autoFocus
        value={draft.proposed}
        onValueChange={onChange}
        alias={alias}
        onNoAccess={onNoAccess}
        className="font-mono text-sm"
        rows={Math.min(10, Math.max(2, draft.proposed.split('\n').length))}
        data-testid="suggest-input"
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          if (e.key === 'Escape') onDone(false)
        }}
      />
      <div className="mt-2">
        <MentionTextarea
          value={reason}
          onValueChange={setReason}
          alias={alias}
          onNoAccess={onNoAccess}
          placeholder="Why? (optional)"
          rows={1}
          className="min-h-8 resize-none py-1 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
            if (e.key === 'Escape') onDone(false)
          }}
        />
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={busy || draft.proposed === draft.original}>
          Suggest
        </Button>
      </div>
    </div>
  )
}
