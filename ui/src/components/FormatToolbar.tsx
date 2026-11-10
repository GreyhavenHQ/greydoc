import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { EditorState, StateCommand } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { yUndoManagerKeymap } from 'y-codemirror.next'
import {
  Bold,
  Code,
  Highlighter,
  ImagePlus,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table,
  Undo2,
} from 'lucide-react'
import { formatState, insertBlock, setHeading, toggleList, toggleQuote, toggleWrap, type FormatState } from '@/editor/format'
import { activeCell, cellHistory, focusCell, toggleCellMark } from '@/editor/live'
import { uploadFiles } from '@/editor/upload'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const undo = yUndoManagerKeymap.find((k) => k.key === 'Mod-z')!.run!
const redo = yUndoManagerKeymap.find((k) => k.key === 'Mod-Shift-z')!.run!

const mod = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘' : 'Ctrl+'

function Btn({
  label,
  keys,
  on,
  disabled,
  onClick,
  children,
}: {
  label: string
  keys?: string
  on?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  const title = keys ? `${label} (${keys.replace('Mod-', mod)})` : label
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      aria-pressed={on === undefined ? undefined : on}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-md text-foreground/80 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4',
        on && 'bg-primary/12 text-primary hover:bg-primary/15 hover:text-primary',
      )}
    >
      {children}
    </button>
  )
}

const Sep = () => <span className="mx-1 h-5 w-px shrink-0 bg-border" />

const styles = [
  ['p', 'Normal text', ''],
  ['h1', 'Heading 1', 'text-lg font-semibold'],
  ['h2', 'Heading 2', 'text-base font-semibold'],
  ['h3', 'Heading 3', 'font-semibold'],
  ['h4', 'Heading 4', 'text-sm font-semibold'],
] as const

// FormatToolbar is the bar above the editor. Every button runs an editor command on the Markdown text.
// sink receives the editor state after each change, so only the bar re-renders.
export function FormatToolbar({
  view,
  alias,
  sink,
  onLink,
}: {
  view: EditorView | null
  alias: string
  sink: RefObject<((s: EditorState) => void) | null>
  onLink: (view: EditorView) => void
}) {
  const [fmt, setFmt] = useState<FormatState | null>(() => (view ? formatState(view.state) : null))
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => {
    sink.current = (s) => setFmt(formatState(s))
    if (view) setFmt(formatState(view.state))
    return () => {
      sink.current = null
    }
  }, [view, sink])
  // A grid cell holds one line of text: marks and history apply to it, line and block commands do not.
  const [inCell, setInCell] = useState(false)
  useEffect(() => {
    if (!view) return
    const update = () => setInCell(!!activeCell(view))
    const later = () => setTimeout(update)
    const dom = view.contentDOM
    dom.addEventListener('focusin', update)
    dom.addEventListener('focusout', later)
    return () => {
      dom.removeEventListener('focusin', update)
      dom.removeEventListener('focusout', later)
    }
  }, [view])
  const mark = (m: string) => () => {
    const cell = view && activeCell(view)
    if (cell) toggleCellMark(view, cell, m)
    else run(toggleWrap(m))()
  }
  const history = (which: 'undo' | 'redo') => () => {
    const cell = view && activeCell(view)
    if (cell) cellHistory(view, cell, which)
    else run(which === 'undo' ? undo : redo)()
  }
  const run = (cmd: StateCommand | ((v: EditorView) => boolean)) => () => {
    if (!view) return
    ;(cmd as (v: EditorView) => boolean)(view)
    view.focus()
  }
  const block = fmt?.block === 'h5' || fmt?.block === 'h6' ? 'h4' : (fmt?.block ?? 'p')
  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b bg-background px-3" data-testid="format-toolbar" role="toolbar" aria-label="Formatting">
      <Btn label="Undo" keys="Mod-Z" onClick={history('undo')}>
        <Undo2 />
      </Btn>
      <Btn label="Redo" keys="Mod-Shift-Z" onClick={history('redo')}>
        <Redo2 />
      </Btn>
      <Sep />
      <Select
        disabled={inCell}
        value={block}
        onValueChange={(v) => {
          if (!view) return
          setHeading(v === 'p' ? 0 : Number(v[1]))(view)
          view.focus()
        }}
      >
        <SelectTrigger size="sm" aria-label="Paragraph style" className="h-8 w-36 shrink-0 border-none shadow-none hover:bg-muted" onMouseDown={(e) => e.preventDefault()}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent onCloseAutoFocus={(e) => e.preventDefault()}>
          {styles.map(([v, label, cls]) => (
            <SelectItem key={v} value={v}>
              <span className={cls}>{label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Sep />
      <Btn label="Bold" keys="Mod-B" on={!inCell && !!fmt?.bold} onClick={mark('**')}>
        <Bold />
      </Btn>
      <Btn label="Italic" keys="Mod-I" on={!inCell && !!fmt?.italic} onClick={mark('*')}>
        <Italic />
      </Btn>
      <Btn label="Strikethrough" keys="Mod-Shift-X" on={!inCell && !!fmt?.strike} onClick={mark('~~')}>
        <Strikethrough />
      </Btn>
      <Btn label="Highlight" keys="Mod-Shift-H" onClick={mark('==')}>
        <Highlighter />
      </Btn>
      <Btn label="Inline code" keys="Mod-E" on={!inCell && !!fmt?.code} onClick={mark('`')}>
        <Code />
      </Btn>
      <Btn disabled={inCell} label="Link" keys="Mod-K" on={!inCell && !!fmt?.link} onClick={() => view && onLink(view)}>
        <Link />
      </Btn>
      <Sep />
      <Btn disabled={inCell} label="Bulleted list" keys="Mod-Shift-8" on={!inCell && fmt?.list === 'bullet'} onClick={run(toggleList('bullet'))}>
        <List />
      </Btn>
      <Btn disabled={inCell} label="Numbered list" keys="Mod-Shift-7" on={!inCell && fmt?.list === 'ordered'} onClick={run(toggleList('ordered'))}>
        <ListOrdered />
      </Btn>
      <Btn disabled={inCell} label="Checklist" keys="Mod-Shift-9" on={!inCell && fmt?.list === 'task'} onClick={run(toggleList('task'))}>
        <ListChecks />
      </Btn>
      <Btn disabled={inCell} label="Quote" on={!inCell && !!fmt?.quote} onClick={run(toggleQuote)}>
        <Quote />
      </Btn>
      <Sep />
      <Btn
        disabled={inCell}
        label="Insert table"
        onClick={() => {
          if (!view) return
          run(insertBlock('| § | Column 2 |\n| --- | --- |\n|  |  |\n'))()
          // In live mode the table is a grid: the caret goes into its first cell.
          focusCell(view, view.state.doc.lineAt(view.state.selection.main.head).from, 0, 0)
        }}
      >
        <Table />
      </Btn>
      <Btn disabled={inCell} label="Insert image" onClick={() => file.current?.click()}>
        <ImagePlus />
      </Btn>
      <Btn disabled={inCell} label="Code block" onClick={run(insertBlock('```\n§\n```\n'))}>
        <SquareCode />
      </Btn>
      <Btn disabled={inCell} label="Divider" onClick={run(insertBlock('---\n§'))}>
        <Minus />
      </Btn>
      <input
        ref={file}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (view && files.length) void uploadFiles(view, alias, files, view.state.selection.main.head).then(() => view.focus())
        }}
      />
    </div>
  )
}
