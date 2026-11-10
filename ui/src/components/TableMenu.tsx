import { useRef } from 'react'
import { AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, Code, Columns3, Rows3, Wand2 } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { parseTable } from '@/editor/table'
import { runTableAction, type TableAction, type TableMenuRequest } from '@/editor/live'

// TableMenu is the menu of a grid cell in live mode. The action runs after the menu closes, so the caret can go back to a cell.
export function TableMenu({ request, onClose }: { request: TableMenuRequest; onClose: () => void }) {
  const pending = useRef<TableAction | null>(null)
  const { view, from, row, col, rect } = request
  const t = parseTable(view.state.doc, from)
  const cols = t?.header.cells.length ?? 0
  const item = (action: TableAction, label: string, icon: React.ReactNode, disabled = false) => (
    <DropdownMenuItem disabled={disabled} onSelect={() => (pending.current = action)}>
      {icon}
      {label}
    </DropdownMenuItem>
  )
  return (
    <DropdownMenu open onOpenChange={(o) => !o && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: 'fixed', left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-52"
        data-testid="table-menu"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          runTableAction(view, from, row, col, pending.current ?? 'focus')
        }}
      >
        {item('row-above', 'Add row above', <ArrowUpToLine />, row === 0)}
        {item('row-below', 'Add row below', <ArrowDownToLine />)}
        {item('col-left', 'Add column left', <ArrowLeftToLine />)}
        {item('col-right', 'Add column right', <ArrowRightToLine />)}
        <DropdownMenuSeparator />
        {item('del-row', 'Delete row', <Rows3 />, row === 0)}
        {item('del-col', 'Delete column', <Columns3 />, cols < 2)}
        <DropdownMenuSeparator />
        {item('align-left', 'Align left', <AlignLeft />)}
        {item('align-center', 'Align center', <AlignCenter />)}
        {item('align-right', 'Align right', <AlignRight />)}
        <DropdownMenuSeparator />
        {item('tidy', 'Tidy table', <Wand2 />)}
        {item('source', 'Show as Markdown', <Code />)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
