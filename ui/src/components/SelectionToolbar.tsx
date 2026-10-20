import type { ReactNode } from 'react'
import { FilePenLine, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'

export const toolbarButton = 'h-7 gap-1 px-2 text-background hover:bg-background/15 hover:text-background'

// SelectionToolbar floats above a text selection. It keeps the selection when pressed.
export function SelectionToolbar({
  top,
  left,
  onComment,
  onSuggest,
  children,
}: {
  top: number
  left: number
  onComment: () => void
  onSuggest: () => void
  children?: ReactNode
}) {
  return (
    <div
      className="absolute z-20 flex items-center gap-0.5 rounded-lg bg-foreground p-1 text-background shadow-lg ring-1 ring-black/10"
      style={{ top, left: Math.max(8, left) }}
      data-testid="selection-toolbar"
      onMouseDown={(e) => e.preventDefault()}
    >
      <Button size="sm" variant="ghost" className={toolbarButton} onClick={onComment} title="Comment: add a remark for others. The text does not change.">
        <MessageSquarePlus className="size-3.5" /> Comment
      </Button>
      <Button size="sm" variant="ghost" className={toolbarButton} onClick={onSuggest} title="Suggest: propose new text. A writer accepts or rejects it.">
        <FilePenLine className="size-3.5" /> Suggest
      </Button>
      {children}
    </div>
  )
}
