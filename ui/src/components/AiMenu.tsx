import { useState } from 'react'
import { ArrowUp, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { api, withShare } from '@/lib/api'
import { useMe } from '@/lib/me'

export interface AiTarget {
  anchor_start: string
  anchor_end: string
  original: string
}

// AiMenu asks the AI about the selection: in the person's own words first, or with one of the server's presets.
// Each preset shows the exact instruction the model gets. The answer comes back as a suggestion to review.
export function AiMenu({
  alias,
  target,
  onCreated,
  triggerClassName = 'h-7 gap-1 px-2',
  onStart,
}: {
  alias: string
  target: () => AiTarget | null
  onCreated: () => void
  triggerClassName?: string
  // onStart runs once the request is sent, for example to close the selection toolbar.
  onStart?: () => void
}) {
  const { me } = useMe()
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [open, setOpen] = useState(false)
  const presets = me?.ai_actions ?? []

  const run = async (action: string, instruction?: string) => {
    const t = target()
    if (!t) return
    setOpen(false)
    setBusy(true)
    onStart?.()
    const toastId = toast.loading('Asking the AI…')
    try {
      await api.post(withShare(`/api/notes/${alias}/ai`), { action, instruction, ...t })
      toast.success('AI suggestion ready to review', { id: toastId })
      setPrompt('')
      onCreated()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), { id: toastId })
    } finally {
      setBusy(false)
    }
  }
  const send = () => prompt.trim() && run('prompt', prompt.trim())

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className={triggerClassName} disabled={busy} title="AI: the answer comes back as a suggestion to review.">
          {busy ? <Spinner className="size-3.5" /> : <Sparkles className="size-3.5" />} AI
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-2" onCloseAutoFocus={(e) => e.preventDefault()} data-testid="ai-menu">
        <div className="relative">
          <textarea
            autoFocus
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="Tell the AI what to do with the selection"
            aria-label="Tell the AI what to do with the selection"
            className="w-full resize-none rounded-md border bg-background px-3 py-2 pr-10 text-sm outline-none focus:border-primary"
          />
          <Button size="icon" className="absolute right-2 bottom-3 size-7" aria-label="Send to the AI" disabled={!prompt.trim()} onClick={send}>
            <ArrowUp className="size-4" />
          </Button>
        </div>
        <div className="px-1 pt-0.5 pb-2 text-[11px] text-muted-foreground">Enter to send, Shift+Enter for a new line.</div>
        {presets.length > 0 && (
          <div className="border-t pt-1.5">
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => run(p.id)}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                title={p.instruction}
                data-testid="ai-preset"
              >
                <span className="text-sm font-medium">{p.label}</span>
                <span className="line-clamp-2 text-xs text-muted-foreground">{p.instruction}</span>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
