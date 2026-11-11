import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { EditorState, StateCommand } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { yUndoManagerKeymap } from 'y-codemirror.next'
import { startCompletion } from '@codemirror/autocomplete'
import type * as Y from 'yjs'
import {
  Bold,
  Code,
  Ellipsis,
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
import { formatState, insertBlock, insertFootnote, setHeading, toggleList, toggleQuote, toggleWrap, type FormatState } from '@/editor/format'
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

type Command = StateCommand | ((v: EditorView) => boolean)

// linkDocument starts a [[ link and opens the list of documents.
const linkDocument = (view: EditorView) => {
  const at = view.state.selection.main.head
  view.dispatch({ changes: { from: at, insert: '[[' }, selection: { anchor: at + 2 }, userEvent: 'input.type' })
  startCompletion(view)
  return true
}

const callouts = ['Note', 'Tip', 'Important', 'Warning', 'Caution']
const boxes = ['Info', 'Success', 'Warning', 'Danger']

// Action is one toolbar command. It shows as a button when it fits, and as a menu item otherwise.
interface Action {
  label: string
  keys?: string
  icon: ReactNode
  on?: boolean
  disabled?: boolean
  act: () => void
}

interface Group {
  title: string
  // width is what the group takes in the bar, in pixels, with its separator.
  width: number
  actions: Action[]
}

// MoreMenu holds what the bar cannot show: the groups that do not fit, then the syntax beyond the common buttons.
// Like the toolbar buttons, its items never take the focus, so the editor keeps its cursor and typing goes on.
function MoreMenu({ view, inCell, groups }: { view: EditorView | null; inCell: boolean; groups: Group[] }) {
  // open holds where the panel goes. It is in a portal, so the bar does not clip it.
  const [open, setOpen] = useState<{ top: number; right: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(null)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(null)
    }
    document.addEventListener('mousedown', down, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [open])
  const usable = !inCell || groups.some((g) => g.actions.some((a) => !a.disabled))
  useEffect(() => {
    if (!usable) setOpen(null)
  }, [usable])
  const run = (cmd: Command) => {
    setOpen(null)
    if (!view) return
    view.focus()
    cmd(view)
  }
  const toggle = () => {
    const r = button.current!.getBoundingClientRect()
    setOpen((o) => (o ? null : { top: r.bottom + 8, right: window.innerWidth - r.right }))
  }
  const entry = (label: string, act: () => void, keys?: string, disabled?: boolean, on?: boolean) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-pressed={on}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        setOpen(null)
        act()
      }}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40',
        on && 'text-primary',
      )}
    >
      {label}
      {keys && <span className="ml-auto text-xs tracking-widest text-muted-foreground">{keys.replace('Mod-', mod)}</span>}
    </button>
  )
  const item = (label: string, cmd: Command, keys?: string) => entry(label, () => run(cmd), keys, inCell)
  const chips = (label: string, names: string[], cmd: (name: string) => Command) => (
    <div className="flex items-center gap-1 px-2 py-1 text-sm" role="group" aria-label={label}>
      <span className="w-14 shrink-0">{label}</span>
      <div className="flex flex-wrap gap-1">
        {names.map((n) => (
          <button
            key={n}
            type="button"
            role="menuitem"
            aria-label={`${label} ${n}`}
            disabled={inCell}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(cmd(n))}
            className="rounded-full border px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  )
  const heading = (text: string) => <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{text}</div>
  const line = <div className="-mx-1 my-1 h-px bg-border" />
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label="Other formats"
        title="Other formats"
        aria-haspopup="menu"
        aria-expanded={!!open}
        disabled={!usable}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-md text-foreground/80 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4',
          open && 'bg-muted',
        )}
      >
        <Ellipsis />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            aria-label="Other formats"
            style={{ top: open.top, right: open.right }}
            className="fixed z-50 max-h-[70vh] w-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {groups.map((g) => (
              <div key={g.title}>
                {heading(g.title)}
                {g.actions.map((a) => entry(a.label, a.act, a.keys, a.disabled, a.on))}
                {line}
              </div>
            ))}
            {heading('Text')}
            {item('Underline', toggleWrap('++'), 'Mod-U')}
            {item('Superscript', toggleWrap('^'), 'Mod-.')}
            {item('Subscript', toggleWrap('~'), 'Mod-,')}
            {item('Inline formula', toggleWrap('$'))}
            {line}
            {heading('Blocks')}
            {chips('Callout', callouts, (c) => insertBlock(`> [!${c.toUpperCase()}]\n> §\n`))}
            {chips('Box', boxes, (b) => insertBlock(`:::${b.toLowerCase()}\n§\n:::\n`))}
            {item('Collapsible section', insertBlock(':::spoiler Details\n§\n:::\n'))}
            {item('Formula', insertBlock('$$\n§\n$$\n'))}
            {item('Diagram', insertBlock('```mermaid\nflowchart LR\n  Start --> §End\n```\n'))}
            {item('CSV table', insertBlock('```csvpreview header="true"\nname,team\n§\n```\n'))}
            {item('Definition', insertBlock('Term\n: §\n'))}
            {item('Table of contents', insertBlock('[toc]\n§'))}
            {item('Footnote', insertFootnote)}
            {line}
            {item('Link to a document', linkDocument)}
          </div>,
          document.body,
        )}
    </>
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

// Pixel widths of the bar: a button with its gap, a separator with its margins and gap, the paragraph style menu.
const BTN = 34
const SEP = 11
const STYLE = 146
// The bar always shows its padding, undo, redo, bold, italic and the menu button.
const FIXED = 24 + 2 * BTN + SEP + 2 * BTN + SEP + BTN

// FormatToolbar is the bar above the editor. Every button runs an editor command on the Markdown text.
// sink receives the editor state after each change, so only the bar re-renders.
export function FormatToolbar({
  view,
  alias,
  sink,
  onLink,
  undoManager,
}: {
  view: EditorView | null
  alias: string
  sink: RefObject<((s: EditorState) => void) | null>
  onLink: (view: EditorView) => void
  undoManager: Y.UndoManager | null
}) {
  const [history, setHistory] = useState({ undo: false, redo: false })
  useEffect(() => {
    if (!undoManager) return
    const update = () => setHistory({ undo: undoManager.canUndo(), redo: undoManager.canRedo() })
    update()
    const events = ['stack-item-added', 'stack-item-popped', 'stack-cleared', 'stack-item-updated'] as const
    for (const e of events) undoManager.on(e, update)
    return () => {
      for (const e of events) undoManager.off(e, update)
    }
  }, [undoManager])
  const [fmt, setFmt] = useState<FormatState | null>(() => (view ? formatState(view.state) : null))
  const file = useRef<HTMLInputElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(Infinity)
  useEffect(() => {
    const el = bar.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
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
  const run = (cmd: StateCommand | ((v: EditorView) => boolean)) => () => {
    if (!view) return
    ;(cmd as (v: EditorView) => boolean)(view)
    view.focus()
  }
  const mark = (m: string) => () => {
    const cell = view && activeCell(view)
    if (cell) toggleCellMark(view, cell, m)
    else run(toggleWrap(m))()
  }
  const step = (which: 'undo' | 'redo') => () => {
    const cell = view && activeCell(view)
    if (cell) cellHistory(view, cell, which)
    else run(which === 'undo' ? undo : redo)()
  }
  const setStyle = (v: string) => {
    if (!view) return
    setHeading(v === 'p' ? 0 : Number(v[1]))(view)
    view.focus()
  }
  const block = fmt?.block === 'h5' || fmt?.block === 'h6' ? 'h4' : (fmt?.block ?? 'p')
  const off = !inCell
  const groups: Group[] = [
    {
      title: 'Paragraph style',
      width: SEP + STYLE,
      actions: styles.map(([v, label]) => ({ label, icon: null, on: off && block === v, disabled: inCell, act: () => setStyle(v) })),
    },
    {
      title: 'Marks',
      width: 4 * BTN,
      actions: [
        { label: 'Strikethrough', keys: 'Mod-Shift-X', icon: <Strikethrough />, on: off && !!fmt?.strike, act: mark('~~') },
        { label: 'Highlight', keys: 'Mod-Shift-H', icon: <Highlighter />, act: mark('==') },
        { label: 'Inline code', keys: 'Mod-E', icon: <Code />, on: off && !!fmt?.code, act: mark('`') },
        { label: 'Link', keys: 'Mod-K', icon: <Link />, on: off && !!fmt?.link, disabled: inCell, act: () => view && onLink(view) },
      ],
    },
    {
      title: 'Lists',
      width: SEP + 4 * BTN,
      actions: [
        { label: 'Bulleted list', keys: 'Mod-Shift-8', icon: <List />, on: off && fmt?.list === 'bullet', disabled: inCell, act: run(toggleList('bullet')) },
        { label: 'Numbered list', keys: 'Mod-Shift-7', icon: <ListOrdered />, on: off && fmt?.list === 'ordered', disabled: inCell, act: run(toggleList('ordered')) },
        { label: 'Checklist', keys: 'Mod-Shift-9', icon: <ListChecks />, on: off && fmt?.list === 'task', disabled: inCell, act: run(toggleList('task')) },
        { label: 'Quote', icon: <Quote />, on: off && !!fmt?.quote, disabled: inCell, act: run(toggleQuote) },
      ],
    },
    {
      title: 'Insert',
      width: SEP + 4 * BTN,
      actions: [
        {
          label: 'Insert table',
          icon: <Table />,
          disabled: inCell,
          act: () => {
            if (!view) return
            run(insertBlock('| § | Column 2 |\n| --- | --- |\n|  |  |\n'))()
            // In live mode the table is a grid: the caret goes into its first cell.
            focusCell(view, view.state.doc.lineAt(view.state.selection.main.head).from, 0, 0)
          },
        },
        { label: 'Insert image', icon: <ImagePlus />, disabled: inCell, act: () => file.current?.click() },
        { label: 'Code block', icon: <SquareCode />, disabled: inCell, act: run(insertBlock('```\n§\n```\n')) },
        { label: 'Divider', icon: <Minus />, disabled: inCell, act: run(insertBlock('---\n§')) },
      ],
    },
  ]
  // The groups that fit stay in the bar, in this order. The others go into the menu.
  let room = width - FIXED
  let fits = 0
  while (fits < groups.length && room >= groups[fits].width) room -= groups[fits++].width
  const shown = new Set(groups.slice(0, fits).map((g) => g.title))
  const buttons = (title: string) =>
    groups
      .find((g) => g.title === title)!
      .actions.map((a) => (
        <Btn key={a.label} label={a.label} keys={a.keys} on={a.on} disabled={a.disabled} onClick={a.act}>
          {a.icon}
        </Btn>
      ))
  return (
    <div ref={bar} className="flex h-11 shrink-0 items-center gap-0.5 overflow-hidden border-b bg-background px-3" data-testid="format-toolbar" role="toolbar" aria-label="Formatting">
      <Btn label="Undo" keys="Mod-Z" disabled={!history.undo} onClick={step('undo')}>
        <Undo2 />
      </Btn>
      <Btn label="Redo" keys="Mod-Shift-Z" disabled={!history.redo} onClick={step('redo')}>
        <Redo2 />
      </Btn>
      {shown.has('Paragraph style') && (
        <>
          <Sep />
          <Select disabled={inCell} value={block} onValueChange={setStyle}>
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
        </>
      )}
      <Sep />
      <Btn label="Bold" keys="Mod-B" on={off && !!fmt?.bold} onClick={mark('**')}>
        <Bold />
      </Btn>
      <Btn label="Italic" keys="Mod-I" on={off && !!fmt?.italic} onClick={mark('*')}>
        <Italic />
      </Btn>
      {shown.has('Marks') && buttons('Marks')}
      {shown.has('Lists') && (
        <>
          <Sep />
          {buttons('Lists')}
        </>
      )}
      {shown.has('Insert') && (
        <>
          <Sep />
          {buttons('Insert')}
        </>
      )}
      <Sep />
      <MoreMenu view={view} inCell={inCell} groups={groups.filter((g) => !shown.has(g.title))} />
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
