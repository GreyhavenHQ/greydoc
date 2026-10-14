import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { api, withShare } from '@/lib/api'

export interface AiTarget {
  anchor_start: string
  anchor_end: string
  original: string
}

const actions = [
  { id: 'refine', label: 'Refine' },
  { id: 'shorten', label: 'Shorten' },
  { id: 'fix', label: 'Fix spelling and grammar' },
  { id: 'diagram', label: 'Make a diagram below' },
  { id: 'continue', label: 'Continue writing' },
]

// AiMenu sends the selection to the server's AI endpoint. The answer comes back as a suggestion to review.
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
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [open, setOpen] = useState(false)

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
      onCreated()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e), { id: toastId })
    } finally {
      setBusy(false)
      setPrompt('')
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className={triggerClassName} disabled={busy} title="AI: the answer comes back as a suggestion to review.">
          {busy ? <Spinner className="size-3.5" /> : <Sparkles className="size-3.5" />} AI
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" onCloseAutoFocus={(e) => e.preventDefault()}>
        {actions.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => run(a.id)}>
            {a.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <form
          className="p-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (prompt.trim()) run('prompt', prompt)
          }}
        >
          <Input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Ask for a change…"
            className="h-8 text-sm"
          />
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
