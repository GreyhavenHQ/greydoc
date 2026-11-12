import { Copy, ExternalLink, FileText, Pencil, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import type { LinkInfo } from '@/editor/format'

const iconButton =
  'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5'

// LinkCard shows under the link that holds the cursor, as in a word processor: the address opens in a new tab.
// It never takes the focus, so typing goes on in the text.
export function LinkCard({
  info,
  top,
  left,
  onOpen,
  onEdit,
  onRemove,
}: {
  info: LinkInfo
  top: number
  left: number
  onOpen: (info: LinkInfo) => void
  onEdit?: () => void
  onRemove?: () => void
}) {
  const external = !info.note && !info.url.startsWith('/') && !info.url.startsWith('#')
  return (
    <div
      className="absolute z-20 flex max-w-sm items-center gap-1 rounded-lg border bg-popover py-1 pr-1 pl-2.5 text-sm text-popover-foreground shadow-md"
      style={{ top, left }}
      data-testid="link-card"
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest('a')) e.preventDefault()
      }}
    >
      {info.note ? <FileText className="size-3.5 shrink-0 text-muted-foreground" /> : <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />}
      <a
        href={info.url}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        className="min-w-0 truncate text-primary underline underline-offset-2"
        onClick={(e) => {
          if (external) return
          e.preventDefault()
          onOpen(info)
        }}
      >
        {info.note ? `Open ${info.text}` : info.url}
      </a>
      <span className="mx-1 h-4 w-px shrink-0 bg-border" />
      <button
        type="button"
        aria-label="Copy link"
        title="Copy link"
        className={iconButton}
        onClick={() => navigator.clipboard?.writeText(info.note ? location.origin + info.url : info.url).then(() => toast.success('Link copied'))}
      >
        <Copy />
      </button>
      {onEdit && (
        <button type="button" aria-label="Edit link" title="Edit link" className={iconButton} onClick={onEdit}>
          <Pencil />
        </button>
      )}
      {onRemove && (
        <button type="button" aria-label="Remove link" title="Remove link" className={iconButton} onClick={onRemove}>
          <Unlink />
        </button>
      )}
    </div>
  )
}
