import { AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, Code, Columns3, Rows3, Wand2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { MenuItem, MenuPanel, MenuSeparator } from '@/components/MenuPanel'
import { cellAt, runTableAction, type TableAction, type TableMenuRequest } from '@/editor/live'

// TableMenu is the menu of a grid cell in live mode. The cell keeps the focus, so typing after a choice goes into it.
export function TableMenu({ request, onClose }: { request: TableMenuRequest; onClose: () => void }) {
  const { view, cell, rect } = request
  const { t, row } = cellAt(view, cell)
  const cols = t?.header.cells.length ?? 0
  const item = (action: TableAction, label: string, icon: ReactNode, disabled = false) => (
    <MenuItem
      disabled={disabled}
      onSelect={() => {
        onClose()
        runTableAction(view, cell, action)
      }}
    >
      {icon}
      {label}
    </MenuItem>
  )
  return (
    <MenuPanel top={rect.bottom + 4} left={Math.min(rect.left, window.innerWidth - 216)} label="Table" testId="table-menu" className="w-52" onClose={onClose}>
      {item('row-above', 'Add row above', <ArrowUpToLine />, row === 0)}
      {item('row-below', 'Add row below', <ArrowDownToLine />)}
      {item('col-left', 'Add column left', <ArrowLeftToLine />)}
      {item('col-right', 'Add column right', <ArrowRightToLine />)}
      <MenuSeparator />
      {item('del-row', 'Delete row', <Rows3 />, row === 0)}
      {item('del-col', 'Delete column', <Columns3 />, cols < 2)}
      <MenuSeparator />
      {item('align-left', 'Align left', <AlignLeft />)}
      {item('align-center', 'Align center', <AlignCenter />)}
      {item('align-right', 'Align right', <AlignRight />)}
      <MenuSeparator />
      {item('tidy', 'Tidy table', <Wand2 />)}
      {item('source', 'Show as Markdown', <Code />)}
    </MenuPanel>
  )
}
