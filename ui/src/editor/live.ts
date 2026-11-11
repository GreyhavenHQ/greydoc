import { ensureSyntaxTree, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { tagHighlighter, tags } from '@lezer/highlight'
import { EditorState, Facet, RangeSet, StateEffect, StateField, Text, type ChangeSpec, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import katex from 'katex'
import { yUndoManagerKeymap } from 'y-codemirror.next'
import { renderInline, renderMarkdown } from '@/render/markdown'
import { cellMarkdown, richCell } from '@/editor/cellhtml'
import { addColumn, addRow, cellText, parseTable, removeColumn, removeRow, setAlign, setCell, tidy, type Align, type Table } from '@/editor/table'
import { naturalSize, renderMermaid, themeMode } from '@/render/mermaid'
import { slugify } from '@/render/plugins'
import { splitFrontMatter } from '@/lib/meta'
import { mentionsOn } from '@/lib/mentions'

// Live preview: Markdown that renders in place, like Obsidian. Lines and blocks under a selection show their source.

const hide = Decoration.replace({})

// LiveStyle picks what the cursor reveals. obsidian shows the Markdown of the active line. document never shows marks.
export type LiveStyle = 'obsidian' | 'document'
export const liveStyle = Facet.define<LiveStyle, LiveStyle>({ combine: (v) => v[0] ?? 'obsidian' })

function revealAt(view: EditorView, dom: HTMLElement) {
  const pos = view.posAtDOM(dom)
  view.dispatch({ selection: { anchor: pos } })
  view.focus()
}

class MermaidWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly mode: 'light' | 'dark',
  ) {
    super()
  }
  eq(o: MermaidWidget) {
    return o.src === this.src && o.mode === this.mode
  }
  get estimatedHeight() {
    return 240
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div')
    el.className = 'cm-lp-block cm-lp-mermaid'
    el.textContent = 'Rendering diagram…'
    void renderMermaid(this.src, this.mode).then((svg) => {
      el.innerHTML = svg
      naturalSize(el)
      view.requestMeasure()
    })
    el.onmousedown = (e) => {
      e.preventDefault()
      revealAt(view, el)
    }
    return el
  }
  ignoreEvent() {
    return false
  }
}

class HTMLBlockWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly cls: string,
  ) {
    super()
  }
  eq(o: HTMLBlockWidget) {
    return o.html === this.html
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div')
    el.className = 'cm-lp-block markdown-body ' + this.cls
    el.innerHTML = this.html
    el.onmousedown = (e) => {
      const a = (e.target as HTMLElement).closest('a')
      const href = a?.getAttribute('href') ?? ''
      // A link of a table of contents goes to its heading in the editor.
      if (href.startsWith('#')) {
        e.preventDefault()
        const line = headingLine(view, decodeURIComponent(href.slice(1)))
        if (line !== null) view.dispatch({ selection: { anchor: line }, effects: EditorView.scrollIntoView(line, { y: 'start' }) })
        view.focus()
        return
      }
      if (a || (e.target as HTMLElement).closest('summary')) return
      e.preventDefault()
      revealAt(view, el)
    }
    el.onclick = (e) => {
      if ((e.target as HTMLElement).closest('a[href^="#"]')) e.preventDefault()
    }
    return el
  }
  ignoreEvent() {
    return false
  }
}

function headingLine(view: EditorView, id: string): number | null {
  const doc = view.state.doc
  for (let n = 1; n <= doc.lines; n++) {
    const m = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(doc.line(n).text)
    if (m && slugify(m[1]) === id) return doc.line(n).from
  }
  return null
}

let tocCache = { key: '', html: '' }

// tocHtml renders the table of contents of the view from the headings of the document.
function tocHtml(headings: string[]): string {
  const key = headings.join('\n')
  if (tocCache.key !== key) {
    const html = renderMarkdown('[toc]\n\n' + headings.join('\n\n')).html
    tocCache = { key, html: /<nav class="toc">[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '' }
  }
  return tocCache.html
}

const emojiCache = new Map<string, string>()
// emojiOf gives the character the view shows for :name:, or the text itself when there is none.
function emojiOf(code: string): string {
  let e = emojiCache.get(code)
  if (e === undefined) {
    e = renderInline(code)
    emojiCache.set(code, e)
  }
  return e
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super()
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.display === this.display
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'cm-lp-block cm-lp-math' : 'cm-lp-math-inline'
    el.innerHTML = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: false })
    el.onmousedown = (e) => {
      e.preventDefault()
      revealAt(view, el)
    }
    return el
  }
  ignoreEvent() {
    return false
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super()
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt
  }
  toDOM() {
    const img = document.createElement('img')
    img.className = 'cm-lp-img'
    img.src = /^(https?:|\/)/.test(this.src) ? this.src : ''
    img.alt = this.alt
    return img
  }
}

class BulletWidget extends WidgetType {
  constructor(readonly label: string) {
    super()
  }
  eq(o: BulletWidget) {
    return o.label === this.label
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = this.label === '•' ? 'cm-lp-bullet' : 'cm-lp-bullet cm-lp-number'
    el.textContent = this.label
    return el
  }
}

export const boxKinds = ['info', 'success', 'warning', 'danger', 'spoiler']
const alertKinds = ['note', 'tip', 'important', 'warning', 'caution']
const title = (k: string) => k[0].toUpperCase() + k.slice(1)

// blockKindChange changes the kind of the box or the alert that starts on the line at pos.
export function blockKindChange(state: EditorState, pos: number, kind: string): ChangeSpec | null {
  const line = state.doc.lineAt(pos)
  const box = /^:::\s*(\w+)/.exec(line.text)
  if (box) {
    const at = line.from + box[0].length - box[1].length
    return { from: at, to: at + box[1].length, insert: kind }
  }
  const alert = /^>\s*\[!(\w+)\]/.exec(line.text)
  if (alert) {
    const at = line.from + alert[0].length - alert[1].length - 1
    return { from: at, to: at + alert[1].length, insert: kind.toUpperCase() }
  }
  return null
}

// KindWidget names a box or an alert and lets a writer change its kind.
class KindWidget extends WidgetType {
  constructor(
    readonly kind: string,
    readonly cls: string,
    readonly block: boolean,
  ) {
    super()
  }
  get label() {
    return title(this.kind)
  }
  eq(o: KindWidget) {
    return o.kind === this.kind && o.cls === this.cls && o.block === this.block
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.block ? 'div' : 'span')
    el.className = 'cm-lp-kind ' + this.cls
    const name = document.createElement('span')
    name.className = 'cm-lp-kind-name'
    name.textContent = this.label
    el.appendChild(name)
    if (!view.state.readOnly && view.state.facet(canToggleTasks)()) {
      const kinds = alertKinds.includes(this.kind) && this.cls.includes('alert') ? alertKinds : boxKinds
      const select = document.createElement('select')
      select.className = 'cm-lp-kind-select'
      select.setAttribute('aria-label', this.cls.includes('alert') ? 'Callout type' : 'Box type')
      for (const k of kinds) select.add(new Option(title(k), k, false, k === this.kind))
      select.onmousedown = (e) => e.stopPropagation()
      select.onchange = () => {
        const change = blockKindChange(view.state, view.posAtDOM(el), select.value)
        if (change) view.dispatch({ changes: change, userEvent: 'input.format' })
        view.focus()
      }
      el.appendChild(select)
    }
    return el
  }
  ignoreEvent() {
    return true
  }
}

class BoxEdgeWidget extends WidgetType {
  constructor(readonly cls: string) {
    super()
  }
  eq(o: BoxEdgeWidget) {
    return o.cls === this.cls
  }
  toDOM() {
    const el = document.createElement('div')
    el.className = 'cm-lp-box-bottom ' + this.cls
    return el
  }
}

class LabelWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly cls: string,
  ) {
    super()
  }
  eq(o: LabelWidget) {
    return o.text === this.text && o.cls === this.cls
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = this.cls
    el.textContent = this.text
    return el
  }
}

const undo = yUndoManagerKeymap.find((k) => k.key === 'Mod-z')!.run!
const redo = yUndoManagerKeymap.find((k) => k.key === 'Mod-Shift-z')!.run!

function caretToEnd(el: HTMLElement | undefined) {
  if (!el) return
  el.focus()
  const sel = getSelection()
  sel?.selectAllChildren(el)
  sel?.collapseToEnd()
}

// textOffsets returns the selection inside a cell as offsets in its text.
function textOffsets(el: HTMLElement): [number, number] {
  const sel = getSelection()
  if (!sel?.rangeCount) return [0, 0]
  const r = sel.getRangeAt(0)
  const pre = document.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(r.startContainer, r.startOffset)
  const a = pre.toString().length
  return [a, a + r.toString().length]
}

function selectText(el: HTMLElement, a: number, b: number) {
  const node = el.firstChild
  if (!node) return caretToEnd(el)
  const r = document.createRange()
  r.setStart(node, Math.min(a, node.textContent!.length))
  r.setEnd(node, Math.min(b, node.textContent!.length))
  const sel = getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

const cellWraps: Record<string, string> = { b: '**', i: '*', e: '`' }

export interface TableMenuRequest {
  view: EditorView
  from: number
  row: number
  col: number
  rect: DOMRect
}

// tableMenu opens the table menu of the page for a cell. Without it the grid shows no menu button.
export const tableMenu = Facet.define<(r: TableMenuRequest) => void, ((r: TableMenuRequest) => void) | null>({
  combine: (v) => v[0] ?? null,
})

// showTableSource shows the table at a position as Markdown until the cursor leaves it.
const showTableSource = StateEffect.define<number>()
const tableSource = StateField.define<number>({
  create: () => -1,
  update(v, tr) {
    if (v >= 0) v = tr.changes.mapPos(v)
    for (const e of tr.effects) if (e.is(showTableSource)) v = e.value
    if (v < 0) return v
    const t = parseTable(tr.state.doc, v)
    const head = tr.state.selection.main.head
    return t && head >= t.from && head <= t.to ? t.from : -1
  },
})

export type TableAction =
  | 'row-above'
  | 'row-below'
  | 'col-left'
  | 'col-right'
  | 'del-row'
  | 'del-col'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'tidy'
  | 'source'
  | 'focus'

// runTableAction changes the table at from for the cell at row and col, then puts the caret back in a cell.
export function runTableAction(view: EditorView, from: number, row: number, col: number, action: TableAction) {
  const t = parseTable(view.state.doc, from)
  if (!t) return
  const rows = t.body.length + 1
  const cols = t.header.cells.length
  if (action === 'source') {
    view.focus()
    view.dispatch({ selection: { anchor: t.from }, effects: showTableSource.of(t.from) })
    return
  }
  let changes: ChangeSpec | null = null
  let to = [row, col]
  if (action === 'row-above' && row > 0) changes = addRow(t, row - 1)
  else if (action === 'row-below') [changes, to] = [addRow(t, row), [row + 1, col]]
  else if (action === 'col-left') changes = addColumn(t, col)
  else if (action === 'col-right') [changes, to] = [addColumn(t, col + 1), [row, col + 1]]
  else if (action === 'del-row') [changes, to] = [removeRow(t, row), [Math.min(row, rows - 2), col]]
  else if (action === 'del-col') [changes, to] = [removeColumn(t, col), [row, Math.min(col, cols - 2)]]
  else if (action.startsWith('align-')) changes = setAlign(t, col, action.slice(6) as Align)
  else if (action === 'tidy') changes = tidy(t)
  if (changes) view.dispatch({ changes, userEvent: 'input.table' })
  focusCell(view, t.from, to[0], to[1])
}

// TableWidget shows a table as a grid. Each cell is editable in place and writes to its own span in the text.
// The DOM is patched, not rebuilt, so a remote change keeps the focus and the caret of the person typing.
class TableWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly canEdit: boolean,
  ) {
    super()
  }
  eq(o: TableWidget) {
    return o.src === this.src && o.canEdit === this.canEdit
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-block cm-lp-grid-wrap markdown-body'
    wrap.dataset.editable = String(this.canEdit)
    const table = document.createElement('table')
    table.className = 'cm-lp-grid'
    wrap.appendChild(table)
    if (this.canEdit) {
      // The editor and the page handle mouse events for their own selection. Inside the grid they belong to the cell.
      for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'] as const) wrap.addEventListener(type, (e) => e.stopPropagation())
      wrap.addEventListener('focusin', () => wrap.classList.add('cm-lp-grid-active'))
      wrap.addEventListener('focusout', () => wrap.classList.remove('cm-lp-grid-active'))
      const add = (cls: string, title: string, change: (t: Table) => [ChangeSpec, number, number]) => {
        const b = document.createElement('button')
        b.className = 'cm-lp-grid-add ' + cls
        b.textContent = '+'
        b.title = title
        b.setAttribute('aria-label', title)
        b.onmousedown = (e) => e.preventDefault()
        b.onclick = () => {
          const t = tableAt(view, wrap)
          if (!t) return
          const [changes, r, c] = change(t)
          view.dispatch({ changes, userEvent: 'input.table' })
          focusCell(view, t.from, r, c)
        }
        wrap.appendChild(b)
      }
      const open = view.state.facet(tableMenu)
      if (open) {
        const b = document.createElement('button')
        b.className = 'cm-lp-grid-menu'
        b.textContent = '⋯'
        b.title = 'Table options'
        b.setAttribute('aria-label', 'Table options')
        b.onmousedown = (e) => e.preventDefault()
        b.onclick = () => {
          const t = tableAt(view, wrap)
          if (t) open({ view, from: t.from, row: Number(wrap.dataset.row), col: Number(wrap.dataset.col), rect: b.getBoundingClientRect() })
        }
        wrap.appendChild(b)
      }
      add('cm-lp-grid-add-row', 'Add a row', (t) => [addRow(t, t.body.length), t.body.length + 1, 0])
      add('cm-lp-grid-add-col', 'Add a column', (t) => [addColumn(t, t.header.cells.length), 0, t.header.cells.length])
    }
    this.sync(wrap, view)
    return wrap
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    if (!dom.classList.contains('cm-lp-grid-wrap') || dom.dataset.editable !== String(this.canEdit)) return false
    this.sync(dom, view)
    return true
  }
  sync(wrap: HTMLElement, view: EditorView) {
    const t = parseTable(Text.of(this.src.split('\n')), 0)!
    const table = wrap.querySelector('table')!
    const rows = t.body.length + 1
    const cols = t.header.cells.length
    while (table.rows.length > rows) table.deleteRow(-1)
    for (let r = 0; r < rows; r++) {
      const tr = table.rows[r] ?? table.insertRow()
      while (tr.cells.length > cols) tr.deleteCell(-1)
      for (let c = 0; c < cols; c++) {
        let el = tr.cells[c] as HTMLElement | undefined
        if (!el) {
          el = document.createElement(r === 0 ? 'th' : 'td')
          if (this.canEdit) editableCell(view, wrap, el)
          tr.appendChild(el)
        }
        el.style.textAlign = t.align[c] ?? ''
        const text = cellText(t, r, c)
        if (el === document.activeElement || el.dataset.src === text) continue
        el.dataset.src = text
        el.innerHTML = renderInline(text)
      }
    }
  }
  ignoreEvent() {
    return true
  }
}

const tableAt = (view: EditorView, wrap: HTMLElement) => parseTable(view.state.doc, view.posAtDOM(wrap))

// activeCell is the grid cell of this editor that has the focus.
export function activeCell(view: EditorView): HTMLElement | null {
  const el = document.activeElement as HTMLElement | null
  return el && (el.tagName === 'TD' || el.tagName === 'TH') && el.closest('.cm-lp-grid') && view.contentDOM.contains(el) ? el : null
}

function cellAt(view: EditorView, el: HTMLElement) {
  const wrap = el.closest<HTMLElement>('.cm-lp-grid-wrap')!
  return { t: tableAt(view, wrap), row: (el.parentElement as HTMLTableRowElement).rowIndex, col: (el as HTMLTableCellElement).cellIndex }
}

// cellSource is the Markdown of a cell under edit.
const cellSource = (el: HTMLElement) => (el.dataset.rich ? (cellMarkdown(el) ?? el.textContent ?? '') : (el.textContent ?? ''))

const markTags: Record<string, string[]> = { '**': ['STRONG', 'B'], '*': ['EM', 'I'], '~~': ['S', 'DEL', 'STRIKE'], '`': ['CODE'], '==': ['MARK'] }

function unwrapNode(n: Node) {
  const parent = n.parentNode!
  while (n.firstChild) parent.insertBefore(n.firstChild, n)
  parent.removeChild(n)
}

// toggleRichMark sets a mark on the selection of a rendered cell, or removes the mark around it.
function toggleRichMark(el: HTMLElement, m: string) {
  const sel = getSelection()
  if (!sel?.rangeCount) return
  const range = sel.getRangeAt(0)
  if (!el.contains(range.commonAncestorContainer)) return
  const tags = markTags[m]
  for (let n: Node | null = range.commonAncestorContainer; n && n !== el; n = n.parentNode) {
    if (tags.includes((n as Element).tagName)) return unwrapNode(n)
  }
  if (range.collapsed) return
  const node = document.createElement(tags[0].toLowerCase())
  node.appendChild(range.extractContents())
  for (const inner of node.querySelectorAll(tags.join(','))) unwrapNode(inner)
  range.insertNode(node)
  const r = document.createRange()
  r.selectNodeContents(node)
  sel.removeAllRanges()
  sel.addRange(r)
}

// toggleCellMark wraps the selection of a cell in marker, or removes marker when it surrounds the selection.
export function toggleCellMark(view: EditorView, el: HTMLElement, m: string) {
  const { t, row, col } = cellAt(view, el)
  if (!t) return
  if (el.dataset.rich) {
    toggleRichMark(el, m)
    const next = cellSource(el)
    el.dataset.src = next
    view.dispatch({ changes: setCell(t, row, col, next), userEvent: 'input.format' })
    return
  }
  const text = el.textContent ?? ''
  const [a, b] = textOffsets(el)
  const n = m.length
  let next: string
  let sel: [number, number]
  if (text.slice(a - n, a) === m && text.slice(b, b + n) === m) {
    next = text.slice(0, a - n) + text.slice(a, b) + text.slice(b + n)
    sel = [a - n, b - n]
  } else if (b - a >= 2 * n && text.slice(a, a + n) === m && text.slice(b - n, b) === m) {
    next = text.slice(0, a) + text.slice(a + n, b - n) + text.slice(b)
    sel = [a, b - 2 * n]
  } else {
    next = text.slice(0, a) + m + text.slice(a, b) + m + text.slice(b)
    sel = [a + n, b + n]
  }
  el.textContent = next
  el.dataset.src = next
  view.dispatch({ changes: setCell(t, row, col, next), userEvent: 'input.format' })
  selectText(el, ...sel)
}

// cellHistory runs undo or redo from a cell, then shows the new text of the cell.
export function cellHistory(view: EditorView, el: HTMLElement, which: 'undo' | 'redo') {
  ;(which === 'undo' ? undo : redo)(view)
  const { t, row, col } = cellAt(view, el)
  const text = t ? cellText(t, row, col) : ''
  if (el.dataset.rich) el.innerHTML = renderInline(text)
  else el.textContent = text
  el.dataset.src = text
  caretToEnd(el)
}

// focusCell finds the grid of the table at from after an update and puts the caret at the end of a cell.
export function focusCell(view: EditorView, from: number, row: number, col: number) {
  for (const w of view.contentDOM.querySelectorAll<HTMLElement>('.cm-lp-grid-wrap')) {
    if (view.posAtDOM(w) === from) caretToEnd(w.querySelector('table')!.rows[row]?.cells[col] as HTMLElement | undefined)
  }
}

function editableCell(view: EditorView, wrap: HTMLElement, el: HTMLElement) {
  el.contentEditable = 'true'
  el.spellcheck = true
  const pos = () => [(el.parentElement as HTMLTableRowElement).rowIndex, (el as HTMLTableCellElement).cellIndex] as const
  const write = (text: string) => {
    const t = tableAt(view, wrap)
    const [r, c] = pos()
    el.dataset.src = text
    if (t) view.dispatch({ changes: setCell(t, r, c, text), userEvent: 'input.type' })
  }
  el.oncontextmenu = (e) => {
    const open = view.state.facet(tableMenu)
    const t = tableAt(view, wrap)
    if (!open || !t) return
    e.preventDefault()
    const [r, c] = pos()
    open({ view, from: t.from, row: r, col: c, rect: new DOMRect(e.clientX, e.clientY, 0, 0) })
  }
  el.onfocus = () => {
    const t = tableAt(view, wrap)
    const [r, c] = pos()
    wrap.dataset.row = String(r)
    wrap.dataset.col = String(c)
    const menu = wrap.querySelector<HTMLElement>('.cm-lp-grid-menu')
    if (menu) {
      const a = el.getBoundingClientRect()
      const w = wrap.getBoundingClientRect()
      // On the top right corner of the cell, so it covers no text.
      menu.style.left = a.right - w.left - 9 + 'px'
      menu.style.top = a.top - w.top - 9 + 'px'
    }
    // The document style edits the rendered cell when its Markdown comes back unchanged. Otherwise the cell shows
    // its source as plain text. Equal content stays, so a selection stays.
    const src = t ? cellText(t, r, c) : ''
    if (view.state.facet(liveStyle) === 'document' && richCell(src)) {
      el.dataset.rich = '1'
      if (el.dataset.src !== src) el.innerHTML = renderInline(src)
    } else {
      delete el.dataset.rich
      if (el.textContent !== src || el.childElementCount) el.textContent = src
    }
  }
  el.onblur = () => {
    const t = tableAt(view, wrap)
    const [r, c] = pos()
    const text = t ? cellText(t, r, c) : (el.textContent ?? '')
    el.dataset.src = text
    el.innerHTML = renderInline(text)
  }
  el.oninput = () => write(cellSource(el))
  // Chromium and WebKit do not select a word on double click in an editable cell inside the editor, so the cell does it.
  el.ondblclick = (e) => {
    const sel = getSelection()
    if (!sel) return
    if (!sel.isCollapsed && el.contains(sel.anchorNode) && el.contains(sel.focusNode)) return
    const at = document.caretRangeFromPoint?.(e.clientX, e.clientY)
    if (at && el.contains(at.startContainer)) {
      sel.removeAllRanges()
      sel.addRange(at)
    } else if (!el.contains(sel.anchorNode)) return
    sel.collapseToStart()
    sel.modify('move', 'backward', 'word')
    sel.modify('extend', 'forward', 'word')
  }
  el.onpaste = (e) => {
    e.preventDefault()
    document.execCommand('insertText', false, (e.clipboardData?.getData('text/plain') ?? '').replace(/\r?\n/g, ' '))
  }
  el.onkeydown = (e) => {
    const t = tableAt(view, wrap)
    if (!t) return
    const [r, c] = pos()
    const rows = t.body.length + 1
    const cols = t.header.cells.length
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (mod && cellWraps[key] && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      toggleCellMark(view, el, cellWraps[key])
    } else if (mod && (key === 'z' || key === 'y')) {
      e.preventDefault()
      cellHistory(view, el, key === 'y' || e.shiftKey ? 'redo' : 'undo')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const i = r * cols + c + (e.shiftKey ? -1 : 1)
      if (i < 0) return
      if (i >= rows * cols) {
        view.dispatch({ changes: addRow(t, rows - 1), userEvent: 'input.table' })
        focusCell(view, t.from, rows, 0)
      } else caretToEnd(wrap.querySelector('table')!.rows[Math.floor(i / cols)].cells[i % cols] as HTMLElement)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (r === rows - 1) {
        view.dispatch({ changes: addRow(t, r), userEvent: 'input.table' })
        focusCell(view, t.from, r + 1, c)
      } else caretToEnd(wrap.querySelector('table')!.rows[r + 1].cells[c] as HTMLElement)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const next = r + (e.key === 'ArrowUp' ? -1 : 1)
      if (next >= 0 && next < rows) caretToEnd(wrap.querySelector('table')!.rows[next].cells[c] as HTMLElement)
      else {
        view.focus()
        const anchor = next < 0 ? Math.max(t.from - 1, 0) : Math.min(t.to + 1, view.state.doc.length)
        view.dispatch({ selection: { anchor }, scrollIntoView: true })
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      view.focus()
      view.dispatch({ selection: { anchor: Math.min(t.to + 1, view.state.doc.length) } })
    }
  }
}

// canToggleTasks says whether this user may tick task boxes. People who can only comment or read cannot.
export const canToggleTasks = Facet.define<() => boolean, () => boolean>({
  combine: (v) => v[0] ?? (() => true),
})

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-check'
    box.checked = this.checked
    const allowed = () => !view.state.readOnly && view.state.facet(canToggleTasks)()
    box.disabled = !allowed()
    box.onmousedown = (e) => e.preventDefault()
    box.onclick = (e) => {
      e.preventDefault()
      if (!allowed()) return
      const pos = view.posAtDOM(box)
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' }, userEvent: 'input.toggle' })
    }
    return box
  }
  ignoreEvent() {
    return false
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-lp-hr'
    return el
  }
}

// FrontMatterWidget shows the front matter as one line: the title and the tags. Click to edit the YAML.
class FrontMatterWidget extends WidgetType {
  constructor(
    readonly title: string,
    readonly tags: string[],
    readonly keys: number,
  ) {
    super()
  }
  eq(o: FrontMatterWidget) {
    return o.title === this.title && o.tags.join('\n') === this.tags.join('\n') && o.keys === this.keys
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div')
    el.className = 'cm-lp-props'
    el.title = 'Front matter. Click to edit.'
    el.setAttribute('data-testid', 'front-matter')
    if (this.title) {
      const t = document.createElement('span')
      t.className = 'cm-lp-props-title'
      t.textContent = this.title
      el.appendChild(t)
    }
    for (const tag of this.tags) {
      const chip = document.createElement('span')
      chip.className = 'cm-lp-props-tag'
      chip.textContent = tag
      el.appendChild(chip)
    }
    const rest = this.keys - (this.title ? 1 : 0) - (this.tags.length ? 1 : 0)
    if (rest > 0 || el.childElementCount === 0) {
      const more = document.createElement('span')
      more.className = 'cm-lp-props-more'
      more.textContent = el.childElementCount === 0 ? 'Front matter' : `+${rest} more`
      el.appendChild(more)
    }
    el.onmousedown = (e) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: view.state.doc.line(2).from } })
      view.focus()
    }
    return el
  }
  ignoreEvent() {
    return false
  }
}

function frontMatterEnd(state: EditorState): number {
  const doc = state.doc
  if (doc.lines < 2 || !/^-{3,}$/.test(doc.line(1).text)) return -1
  const open = doc.line(1).text
  for (let n = 2; n <= doc.lines; n++) {
    const t = doc.line(n).text
    if (t.length === open.length && /^(?:-{3,}|\.{3,})$/.test(t)) return doc.line(n).to
  }
  return -1
}

export function liveDecorations(state: EditorState): DecorationSet {
  const doc = state.doc
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state)
  const ranges = state.selection.ranges
  // touchesBlock reveals blocks that cannot be edited in place: diagrams, math and front matter.
  const touchesBlock = (from: number, to: number) => ranges.some((r) => r.from <= to && r.to >= from)
  const docStyle = state.facet(liveStyle) === 'document'
  const touches = (from: number, to: number) => !docStyle && touchesBlock(from, to)
  const lineActive = (pos: number) => {
    const l = doc.lineAt(pos)
    return touches(l.from, l.to)
  }
  const out: Range<Decoration>[] = []
  const mode = typeof document === 'undefined' ? 'light' : themeMode()
  const lineClass = (from: number, to: number, cls: string) => {
    for (let pos = from; pos <= to; ) {
      const l = doc.lineAt(pos)
      out.push(Decoration.line({ class: cls }).range(l.from))
      pos = l.to + 1
    }
  }
  const code: [number, number][] = []
  let alertTo = -1

  const fmEnd = frontMatterEnd(state)
  if (fmEnd > 0) {
    if (touchesBlock(0, fmEnd)) {
      lineClass(0, fmEnd, 'cm-lp-fm')
    } else {
      const { data } = splitFrontMatter(doc.sliceString(0, fmEnd) + '\n')
      const tags = Array.isArray(data?.tags) ? data.tags.map(String) : []
      const title = typeof data?.title === 'string' ? data.title : ''
      const keys = data ? Object.keys(data).length : 0
      out.push(Decoration.replace({ widget: new FrontMatterWidget(title, tags, keys), block: true }).range(0, fmEnd))
    }
  }

  // The Markdown grammar does not know boxes, definitions and [toc]. They render as in the view until the cursor enters them.
  const rendered: [number, number][] = []
  const headings: string[] = []
  const blocks: { from: number; to: number; kind: string }[] = []
  const boxes: { open: { from: number; to: number; text: string }; close: { from: number; to: number }; kind: string }[] = []
  let fence = ''
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (line.from < fmEnd) continue
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line.text)
    if (f && (!fence || f[1].startsWith(fence))) {
      fence = fence ? '' : f[1]
      continue
    }
    if (fence) continue
    if (/^ {0,3}#{1,6}\s/.test(line.text)) headings.push(line.text)
    if (/^\[\[?toc\]?\]$/i.test(line.text.trim())) blocks.push({ from: line.from, to: line.to, kind: 'toc' })
    else if (/^:::\s*\w/.test(line.text)) {
      const kind = /^:::\s*(\w+)/.exec(line.text)![1].toLowerCase()
      let m = n + 1
      while (m <= doc.lines && !/^:::\s*$/.test(doc.line(m).text)) m++
      if (m > doc.lines || !boxKinds.includes(kind)) continue
      boxes.push({ open: line, close: doc.line(m), kind })
      n = m
    } else if (/^:\s/.test(line.text) && n > 1 && doc.line(n - 1).text.trim() && !/^:\s/.test(doc.line(n - 1).text)) {
      out.push(Decoration.line({ class: 'cm-lp-dt' }).range(doc.line(n - 1).from))
      for (; n <= doc.lines && /^:\s/.test(doc.line(n).text); n++) {
        const l = doc.line(n)
        out.push(Decoration.line({ class: 'cm-lp-dd' }).range(l.from))
        if (!lineActive(l.from)) out.push(hide.range(l.from, l.from + 2))
      }
      n--
    }
  }
  // A box is edited in place: its lines take the box style, and its marker lines become its top and bottom edges.
  for (const b of boxes) {
    const cls = 'cm-lp-box cm-lp-box-' + b.kind
    if (b.kind === 'spoiler') {
      const prefix = /^:::\s*spoiler\s*/i.exec(b.open.text)![0]
      out.push(Decoration.line({ class: cls + ' cm-lp-first cm-lp-box-title' }).range(b.open.from))
      out.push(Decoration.replace({ widget: new KindWidget('spoiler', 'cm-lp-kind-spoiler', false) }).range(b.open.from, b.open.from + prefix.length))
    } else {
      out.push(Decoration.replace({ widget: new KindWidget(b.kind, 'cm-lp-box-top ' + cls, true), block: true }).range(b.open.from, b.open.to))
    }
    for (let pos = b.open.to + 1; pos < b.close.from; ) {
      const l = doc.lineAt(pos)
      out.push(Decoration.line({ class: cls }).range(l.from))
      pos = l.to + 1
    }
    out.push(Decoration.replace({ widget: new BoxEdgeWidget(cls), block: true }).range(b.close.from, b.close.to))
  }
  for (const b of blocks) {
    if (touchesBlock(b.from, b.to)) continue
    const html = b.kind === 'toc' ? tocHtml(headings) : renderMarkdown(doc.sliceString(b.from, b.to)).html
    if (!html.trim()) continue
    rendered.push([b.from, b.to])
    out.push(Decoration.replace({ widget: new HTMLBlockWidget(html, 'cm-lp-' + b.kind), block: true }).range(b.from, b.to))
  }
  const inRendered = (pos: number) => rendered.some(([a, b]) => pos >= a && pos <= b)

  tree.iterate({
    enter(node) {
      if (node.from < fmEnd) return node.to <= fmEnd ? false : undefined
      if (rendered.some(([a, b]) => node.from >= a && node.to <= b)) return false
      const name = node.name
      const parent = node.node.parent?.name ?? ''
      const heading = /^ATXHeading(\d)$/.exec(name) ?? /^SetextHeading(\d)$/.exec(name)
      if (heading) {
        lineClass(node.from, node.to, 'cm-lp-h cm-lp-h' + heading[1])
        return
      }
      switch (name) {
        case 'HeaderMark': {
          if (!parent.startsWith('ATXHeading') || lineActive(node.from)) return
          const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
          if (node.from === doc.lineAt(node.from).from) out.push(hide.range(node.from, end))
          else out.push(hide.range(node.from - (doc.sliceString(node.from - 1, node.from) === ' ' ? 1 : 0), node.to))
          return
        }
        case 'Emphasis':
          out.push(Decoration.mark({ class: 'cm-lp-em' }).range(node.from, node.to))
          return
        case 'StrongEmphasis':
          out.push(Decoration.mark({ class: 'cm-lp-strong' }).range(node.from, node.to))
          return
        case 'Strikethrough':
          out.push(Decoration.mark({ class: 'cm-lp-strike' }).range(node.from, node.to))
          return
        case 'InlineCode':
          out.push(Decoration.mark({ class: 'cm-lp-code' }).range(node.from, node.to))
          return
        case 'EmphasisMark':
        case 'StrikethroughMark':
          if (!touches(node.from, node.to) && !lineActive(node.from)) out.push(hide.range(node.from, node.to))
          return
        case 'CodeMark':
          if (parent === 'InlineCode' && !lineActive(node.from)) out.push(hide.range(node.from, node.to))
          return
        case 'Subscript':
        case 'Superscript':
          out.push(Decoration.mark({ class: name === 'Subscript' ? 'cm-lp-sub' : 'cm-lp-sup' }).range(node.from + 1, node.to - 1))
          if (!lineActive(node.from)) {
            out.push(hide.range(node.from, node.from + 1))
            out.push(hide.range(node.to - 1, node.to))
          }
          return false
        case 'Emoji': {
          const code = doc.sliceString(node.from, node.to)
          const e = emojiOf(code)
          if (e !== code && !lineActive(node.from)) out.push(Decoration.replace({ widget: new LabelWidget(e, 'cm-lp-emoji') }).range(node.from, node.to))
          return false
        }
        case 'Link': {
          const cur = node.node
          const marks = cur.getChildren('LinkMark')
          const fn = /^\[\^([^\]\s]+)\]$/.exec(doc.sliceString(node.from, node.to))
          if (fn && !cur.getChild('URL')) {
            const line = doc.lineAt(node.from)
            const def = node.from === line.from && doc.sliceString(node.to, node.to + 1) === ':'
            if (def) out.push(Decoration.line({ class: 'cm-lp-fndef' }).range(line.from))
            if (!lineActive(node.from)) {
              const widget = def ? new LabelWidget(fn[1] + '.', 'cm-lp-fnlabel') : new LabelWidget(fn[1], 'cm-lp-fnref')
              out.push(Decoration.replace({ widget }).range(node.from, def ? node.to + 1 : node.to))
            }
            return false
          }
          // [toc] and [!NOTE] parse as links without a target. They are not links.
          if (!cur.getChild('URL') && marks.length < 3) return false
          if (doc.sliceString(node.from, node.from + 2) === '[@' && /\]\(@[^)]*\)$/.test(doc.sliceString(node.from, node.to))) {
            // Mention chips cover the link when mentions are on. Without them it reads as plain @Name.
            if (!mentionsOn() && marks.length >= 2 && !lineActive(node.from)) {
              out.push(hide.range(marks[0].from, marks[0].to))
              out.push(hide.range(marks[1].from, node.to))
            }
            return false
          }
          if (marks.length >= 2 && !lineActive(node.from)) {
            out.push(Decoration.mark({ class: 'cm-lp-link' }).range(marks[0].to, marks[1].from))
            out.push(hide.range(marks[0].from, marks[0].to))
            out.push(hide.range(marks[1].from, node.to))
          } else {
            out.push(Decoration.mark({ class: 'cm-lp-link' }).range(node.from, node.to))
          }
          return false
        }
        case 'URL':
        case 'Autolink':
          if (parent !== 'Link' && parent !== 'Image') out.push(Decoration.mark({ class: 'cm-lp-link' }).range(node.from, node.to))
          return false
        case 'Image': {
          if (lineActive(node.from)) return false
          const url = node.node.getChild('URL')
          const marks = node.node.getChildren('LinkMark')
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : ''
          let src = url ? doc.sliceString(url.from, url.to) : ''
          src = src.replace(/\s+=\d*x\d*$/, '')
          if (src) out.push(Decoration.replace({ widget: new ImageWidget(src, alt) }).range(node.from, node.to))
          return false
        }
        case 'Blockquote': {
          const first = doc.lineAt(node.from)
          const alert = /^>\s*\[!(note|tip|important|warning|caution)\]/i.exec(first.text)
          lineClass(node.from, node.to, 'cm-lp-quote' + (alert ? ' cm-lp-alert cm-lp-alert-' + alert[1].toLowerCase() : ''))
          out.push(Decoration.line({ class: 'cm-lp-first' }).range(first.from))
          out.push(Decoration.line({ class: 'cm-lp-last' }).range(doc.lineAt(node.to).from))
          if (alert && !lineActive(first.from)) {
            const name = alert[1][0].toUpperCase() + alert[1].slice(1).toLowerCase()
            out.push(Decoration.replace({ widget: new KindWidget(alert[1].toLowerCase(), 'cm-lp-alert-title', false) }).range(first.from, first.from + alert[0].length))
            alertTo = first.from + alert[0].length
          }
          return
        }
        case 'QuoteMark':
          if (node.to <= alertTo && node.from >= doc.lineAt(alertTo).from) return
          if (!lineActive(node.from)) {
            const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
            out.push(hide.range(node.from, end))
          }
          return
        case 'ListMark': {
          const mark = doc.sliceString(node.from, node.to)
          const task = node.node.nextSibling?.name === 'Task'
          const line = doc.lineAt(node.from)
          if (line.from !== doc.lineAt(node.node.parent!.from).from) return
          let depth = 0
          for (let p = node.node.parent; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') depth++
          // A hanging indent, like the view: wrapped lines start under the text, not under the bullet.
          const gap = depth > 1 || node.node.parent!.prevSibling ? '; padding-top: 0.2em' : ''
          out.push(Decoration.line({ attributes: { style: `padding-left: ${depth * 1.6}em; text-indent: -1.6em${gap}` } }).range(line.from))
          if (lineActive(node.from)) return
          const end = Math.min(node.to + 1, line.to)
          if (task) out.push(hide.range(line.from, end))
          else out.push(Decoration.replace({ widget: new BulletWidget(/^[-*+]$/.test(mark) ? '•' : mark) }).range(line.from, end))
          return
        }
        case 'TaskMarker':
          if (!lineActive(node.from)) {
            const checked = /x/i.test(doc.sliceString(node.from, node.to))
            out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to))
            if (checked) {
              const l = doc.lineAt(node.from)
              if (node.to + 1 < l.to) out.push(Decoration.mark({ class: 'cm-lp-done' }).range(node.to + 1, l.to))
            }
          }
          return
        case 'HorizontalRule':
          if (!lineActive(node.from)) out.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to))
          return
        case 'FencedCode': {
          code.push([node.from, node.to])
          const info = node.node.getChild('CodeInfo')
          const lang = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] : ''
          const textNode = node.node.getChild('CodeText')
          const src = textNode ? doc.sliceString(textNode.from, textNode.to) : ''
          const closed = node.node.getChildren('CodeMark').length >= 2
          if (lang === 'csvpreview' && closed && !touchesBlock(node.from, node.to)) {
            const html = renderMarkdown(doc.sliceString(node.from, node.to)).html
            out.push(Decoration.replace({ widget: new HTMLBlockWidget(html, 'cm-lp-csv'), block: true }).range(node.from, node.to))
            return false
          }
          if (lang === 'mermaid' && closed && !touchesBlock(node.from, node.to)) {
            out.push(Decoration.replace({ widget: new MermaidWidget(src, mode), block: true }).range(node.from, node.to))
            return false
          }
          lineClass(node.from, node.to, 'cm-lp-codeblock')
          out.push(Decoration.line({ class: 'cm-lp-first' }).range(doc.lineAt(node.from).from))
          out.push(Decoration.line({ class: 'cm-lp-last' }).range(doc.lineAt(node.to).from))
          for (const m of node.node.getChildren('CodeMark')) {
            lineClass(m.from, m.from, 'cm-lp-fence')
            const l = doc.lineAt(m.from)
            if (!touches(node.from, node.to) && l.length) {
              out.push(Decoration.replace({ widget: new LabelWidget(l.from === node.from ? lang : '', 'cm-lp-lang') }).range(l.from, l.to))
            }
          }
          return false
        }
        case 'HTMLBlock': {
          if (touchesBlock(node.from, node.to)) return false
          const html = renderMarkdown(doc.sliceString(node.from, node.to)).html
          if (html.trim()) out.push(Decoration.replace({ widget: new HTMLBlockWidget(html, 'cm-lp-html'), block: true }).range(node.from, node.to))
          return false
        }
        case 'CodeBlock':
          code.push([node.from, node.to])
          lineClass(node.from, node.to, 'cm-lp-codeblock')
          return false
        case 'Table': {
          const t = parseTable(doc, node.from)
          if (t && t.from === state.field(tableSource, false)) {
            lineClass(t.from, t.to, 'cm-lp-table-src')
            return false
          }
          if (t) {
            const editable = !state.readOnly && state.facet(canToggleTasks)()
            out.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(t.from, t.to), editable), block: true }).range(t.from, t.to))
            return false
          }
          if (touchesBlock(node.from, node.to)) {
            lineClass(node.from, node.to, 'cm-lp-table-src')
            return false
          }
          const html = renderMarkdown(doc.sliceString(node.from, node.to)).html
          out.push(Decoration.replace({ widget: new HTMLBlockWidget(html, 'cm-lp-table'), block: true }).range(node.from, node.to))
          return false
        }
      }
    },
  })

  // The view separates blocks with a 1em margin. A full blank line is taller, so it is shrunk.
  // Only a cursor on the line gives it full height: a selection over it MUST NOT move the text.
  const cursorOn = (pos: number) => ranges.some((r) => r.empty && r.head === pos)
  for (let n = 1; n <= doc.lines; n++) {
    const l = doc.line(n)
    if (l.from > fmEnd && l.length === 0 && !cursorOn(l.from) && !code.some(([a, b]) => l.from > a && l.from < b))
      out.push(Decoration.line({ class: 'cm-lp-blank' }).range(l.from))
  }

  // Math is not in the Markdown grammar: find $$ blocks and $…$ spans outside code.
  const inCode = (pos: number) => code.some(([a, b]) => pos >= a && pos <= b)
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (line.from < fmEnd || inCode(line.from) || inRendered(line.from)) continue
    if (/^\*\[[^\]]+\]:/.test(line.text)) out.push(Decoration.line({ class: 'cm-lp-fndef' }).range(line.from))
    if (line.text.trim() === '$$') {
      let m = n + 1
      while (m <= doc.lines && doc.line(m).text.trim() !== '$$') m++
      if (m > doc.lines) break
      const end = doc.line(m)
      if (!touchesBlock(line.from, end.to)) {
        const tex = doc.sliceString(line.to + 1, end.from - 1)
        out.push(Decoration.replace({ widget: new MathWidget(tex, true), block: true }).range(line.from, end.to))
      }
      n = m
      continue
    }
    if (touchesBlock(line.from, line.to) && !docStyle) continue
    for (const m of line.text.matchAll(/\+\+(?=\S)(.+?)(?<=\S)\+\+/g)) {
      const from = line.from + m.index!
      if (inCode(from)) continue
      out.push(hide.range(from, from + 2))
      out.push(Decoration.mark({ class: 'cm-lp-ins' }).range(from + 2, from + m[0].length - 2))
      out.push(hide.range(from + m[0].length - 2, from + m[0].length))
    }
    for (const m of line.text.matchAll(/\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g)) {
      const from = line.from + m.index!
      if (inCode(from) || m[1].toLowerCase() === 'toc') continue
      const label = m[3] ?? m[1] + (m[2] ?? '')
      out.push(Decoration.replace({ widget: new LabelWidget(label, 'cm-lp-notelink') }).range(from, from + m[0].length))
    }
    for (const m of line.text.matchAll(/==(?=\S)(.+?)(?<=\S)==/g)) {
      const from = line.from + m.index!
      if (inCode(from)) continue
      out.push(hide.range(from, from + 2))
      out.push(Decoration.mark({ class: 'cm-lp-mark' }).range(from + 2, from + m[0].length - 2))
      out.push(hide.range(from + m[0].length - 2, from + m[0].length))
    }
    if (!line.text.includes('$') || touchesBlock(line.from, line.to)) continue
    const re = /(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g
    for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
      const from = line.from + m.index
      if (inCode(from)) continue
      out.push(Decoration.replace({ widget: new MathWidget(m[1], false) }).range(from, from + m[0].length))
    }
  }

  return Decoration.set(out, true)
}

// refreshLive rebuilds the rendered blocks, for example after a theme change.
export const refreshLive = StateEffect.define<null>()

const liveField = StateField.define<DecorationSet>({
  create: (state) => liveDecorations(state),
  update(deco, tr) {
    if (tr.startState.facet(liveStyle) !== tr.state.facet(liveStyle) || tr.startState.readOnly !== tr.state.readOnly)
      return liveDecorations(tr.state)
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(refreshLive)) ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    )
      return liveDecorations(tr.state)
    return deco
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    // In the document style the hidden marks are atomic: the cursor steps over them.
    EditorView.atomicRanges.of((view) => {
      if (view.state.facet(liveStyle) !== 'document') return RangeSet.empty
      const out: Range<Decoration>[] = []
      view.state.field(f).between(0, view.state.doc.length, (from, to, d) => {
        if (d.point && from < to) out.push(d.range(from, to))
      })
      return RangeSet.of(out, true)
    }),
  ],
})

// The values copy render/markdown.css, so live mode looks like the view. parity.spec.ts checks them.
const liveTheme = EditorView.theme({
  '&.cm-live': { backgroundColor: 'rgb(var(--background))' },
  '&.cm-live .cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.65' },
  '&.cm-live .cm-content': { maxWidth: 'calc(var(--doc-width, 728px) + 64px)', margin: '0 auto', padding: '40px 32px 30vh', fontSize: '16px' },
  '&.cm-live .cm-line': { padding: '0' },
  '.cm-lp-h': { fontWeight: '600', lineHeight: '1.25', paddingTop: '0.9em !important' },
  '.cm-lp-h1': { fontSize: '2em', letterSpacing: '-0.01em', paddingTop: '0.4em !important' },
  '.cm-lp-h2': { fontSize: '1.5em', paddingBottom: '0.3em !important', borderBottom: '1px solid rgb(var(--border) / 0.7)', marginBottom: '0.3em' },
  '.cm-lp-h3': { fontSize: '1.25em' },
  '.cm-lp-h4': { fontSize: '1em' },
  '.cm-lp-h5': { fontSize: '0.9em' },
  '.cm-lp-h6': { fontSize: '0.85em', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-blank': { fontSize: '0.55em' },
  '.cm-lp-em': { fontStyle: 'italic' },
  '.cm-lp-strong': { fontWeight: '700' },
  '.cm-lp-strike': { textDecoration: 'line-through' },
  '.cm-lp-done': { textDecoration: 'line-through', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-code': {
    fontFamily: 'var(--font-mono)', fontSize: '0.875em', backgroundColor: 'rgb(var(--muted))', border: '1px solid rgb(var(--border) / 0.6)',
    borderRadius: '4px', padding: '0.1em 0.35em',
  },
  '.cm-lp-link': { color: 'rgb(var(--primary))', textDecoration: 'underline', textUnderlineOffset: '2px' },
  '.cm-lp-quote': { borderLeft: '3px solid rgb(var(--border))', paddingLeft: '1em !important', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-codeblock': {
    fontFamily: 'var(--font-mono)', fontSize: '0.85em', lineHeight: '1.55', backgroundColor: 'rgb(var(--card))',
    padding: '0 1.1765em !important', borderLeft: '1px solid rgb(var(--border) / 0.7)', borderRight: '1px solid rgb(var(--border) / 0.7)',
  },
  '.cm-lp-codeblock.cm-lp-first': { borderTop: '1px solid rgb(var(--border) / 0.7)', borderTopLeftRadius: 'var(--radius)', borderTopRightRadius: 'var(--radius)' },
  '.cm-lp-codeblock.cm-lp-last': {
    borderBottom: '1px solid rgb(var(--border) / 0.7)', borderBottomLeftRadius: 'var(--radius)', borderBottomRightRadius: 'var(--radius)',
  },
  '.cm-lp-fence': { color: 'rgb(var(--muted-foreground) / 0.7)' },
  '.cm-lp-lang': { float: 'right', fontFamily: 'var(--font-sans)', fontSize: '0.8em', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-props': {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', padding: '4px 0 10px', cursor: 'pointer',
    fontSize: '12px', color: 'rgb(var(--muted-foreground))', whiteSpace: 'normal',
  },
  '.cm-lp-props-title': { fontWeight: '600', color: 'rgb(var(--foreground))', marginRight: '4px' },
  '.cm-lp-props-tag': { border: '1px solid rgb(var(--border))', borderRadius: '9999px', padding: '0 8px', lineHeight: '20px', backgroundColor: 'rgb(var(--card))' },
  '.cm-lp-props-more': { fontStyle: 'italic' },
  '.cm-lp-props:hover .cm-lp-props-tag': { borderColor: 'rgb(var(--primary) / 0.5)' },
  '.cm-lp-fm': { fontFamily: 'var(--font-mono)', fontSize: '0.8em', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-bullet': { color: 'rgb(var(--muted-foreground))', display: 'inline-block', width: '1.6em', textIndent: '0', textAlign: 'center' },
  '.cm-lp-number': { textAlign: 'right', paddingRight: '0.4em' },
  '.cm-lp-check': { margin: '0 0.6em 0 0.1em', verticalAlign: '-0.1em', accentColor: 'rgb(var(--primary))', cursor: 'pointer' },
  '.cm-lp-check:disabled': { cursor: 'default' },
  '.cm-lp-hr': { display: 'inline-block', width: '100%', borderTop: '1px solid rgb(var(--border))', verticalAlign: 'middle' },
  '.cm-lp-img': { maxWidth: '100%', borderRadius: 'var(--radius)', verticalAlign: 'top' },
  '.cm-lp-block': { cursor: 'pointer', margin: '0.4em 0', whiteSpace: 'normal', contain: 'inline-size' },
  '.cm-lp-ins': { textDecoration: 'underline' },
  '.cm-lp-sub': { verticalAlign: 'sub', fontSize: '0.75em' },
  '.cm-lp-sup': { verticalAlign: 'super', fontSize: '0.75em' },
  '.cm-lp-fnref': { verticalAlign: 'super', fontSize: '0.75em', color: 'rgb(var(--primary))' },
  '.cm-lp-fnref::before': { content: '"["' },
  '.cm-lp-fnref::after': { content: '"]"' },
  '.cm-lp-fndef': { fontSize: '0.875em', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-fnlabel': { paddingRight: '0.4em' },
  '.cm-lp-notelink': { color: 'rgb(var(--primary))', borderBottom: '1px solid rgb(var(--primary) / 0.4)', cursor: 'text' },
  '.cm-lp-notelink::before': { content: '"↗ "', fontSize: '0.8em', opacity: '0.6' },
  '.cm-lp-mark': { backgroundColor: 'rgb(var(--primary) / 0.22)', borderRadius: '2px', padding: '0 0.15em' },
  '.cm-lp-alert': {
    color: 'rgb(var(--foreground))', borderStyle: 'solid', borderWidth: '0 1px 0 4px !important',
    paddingLeft: '1em !important', paddingRight: '1em !important',
  },
  '.cm-lp-alert.cm-lp-first': {
    borderTopWidth: '1px !important', borderTopLeftRadius: 'var(--radius)', borderTopRightRadius: 'var(--radius)', paddingTop: '0.7em !important',
  },
  '.cm-lp-alert.cm-lp-last': {
    borderBottomWidth: '1px !important', borderBottomLeftRadius: 'var(--radius)', borderBottomRightRadius: 'var(--radius)',
    paddingBottom: '0.7em !important',
  },
  '.cm-lp-alert-title': { fontWeight: '600' },
  // The kind of a box or an alert. A transparent select over its name opens the list of kinds.
  '.cm-lp-kind': { position: 'relative' },
  '.cm-lp-kind-select': { position: 'absolute', inset: '0', opacity: '0', cursor: 'pointer', width: '100%', fontSize: '14px' },
  '.cm-lp-alert-title .cm-lp-kind-name::after, .cm-lp-kind-spoiler .cm-lp-kind-name::after': { content: '" ▾"', fontSize: '0.7em', opacity: '0', fontWeight: '400' },
  '.cm-lp-alert-title:hover .cm-lp-kind-name::after, .cm-lp-kind-spoiler:hover .cm-lp-kind-name::after': { opacity: '0.7' },
  '.cm-lp-box': {
    color: 'rgb(var(--foreground))', borderStyle: 'solid', borderWidth: '0 1px 0 4px !important', paddingLeft: '1em !important', paddingRight: '1em !important',
  },
  '.cm-lp-box-top': { display: 'flex', justifyContent: 'flex-end', height: '0.7em', borderTopWidth: '1px !important', borderTopLeftRadius: 'var(--radius)', borderTopRightRadius: 'var(--radius)', overflow: 'visible' },
  '.cm-lp-box-top .cm-lp-kind-name': {
    position: 'relative', top: '2px', fontSize: '11px', lineHeight: '16px', padding: '0 6px', borderRadius: '9999px', color: 'rgb(var(--muted-foreground))', opacity: '0.45',
  },
  '.cm-lp-box-top .cm-lp-kind-name::after': { content: '" ▾"' },
  '.cm-lp-box-top:hover .cm-lp-kind-name': { opacity: '1', backgroundColor: 'rgb(var(--card))' },
  '.cm-lp-box-top .cm-lp-kind-select': { left: 'auto', width: '80px', height: '18px' },
  '.cm-lp-box-bottom': { height: '0.7em', borderBottomWidth: '1px !important', borderBottomLeftRadius: 'var(--radius)', borderBottomRightRadius: 'var(--radius)', marginBottom: '0.2em' },
  '.cm-lp-box-info': { borderColor: 'rgb(42 127 217 / 0.5) !important', backgroundColor: 'rgb(42 127 217 / 0.07)' },
  '.cm-lp-box-success': { borderColor: 'rgb(42 168 118 / 0.5) !important', backgroundColor: 'rgb(42 168 118 / 0.07)' },
  '.cm-lp-box-warning': { borderColor: 'rgb(196 154 0 / 0.55) !important', backgroundColor: 'rgb(196 154 0 / 0.08)' },
  '.cm-lp-box-danger': { borderColor: 'rgb(var(--destructive) / 0.5) !important', backgroundColor: 'rgb(var(--destructive) / 0.07)' },
  '.cm-lp-box-spoiler': { borderColor: 'rgb(var(--border)) !important', borderLeftWidth: '1px !important', paddingLeft: '0.9em !important' },
  '.cm-lp-box-spoiler.cm-lp-first': { borderTopWidth: '1px !important', borderTopLeftRadius: 'var(--radius)', borderTopRightRadius: 'var(--radius)', paddingTop: '0.4em !important', fontWeight: '500' },
  '.cm-lp-kind-spoiler .cm-lp-kind-name': { fontSize: '0', marginRight: '6px' },
  '.cm-lp-kind-spoiler .cm-lp-kind-name::before': { content: '"▾"', fontSize: '12px' },
  '.cm-lp-kind-spoiler .cm-lp-kind-select': { width: '1.2em' },
  '.cm-lp-dt': { fontWeight: '600' },
  '.cm-lp-dd': { paddingLeft: '1.5em !important' },
  '.cm-lp-alert-note': { borderColor: 'rgb(42 127 217 / 0.5) !important', backgroundColor: 'rgb(42 127 217 / 0.07)' },
  '.cm-lp-alert-tip': { borderColor: 'rgb(42 168 118 / 0.5) !important', backgroundColor: 'rgb(42 168 118 / 0.07)' },
  '.cm-lp-alert-important': { borderColor: 'rgb(166 42 217 / 0.45) !important', backgroundColor: 'rgb(166 42 217 / 0.06)' },
  '.cm-lp-alert-warning': { borderColor: 'rgb(196 154 0 / 0.55) !important', backgroundColor: 'rgb(196 154 0 / 0.08)' },
  '.cm-lp-alert-caution': { borderColor: 'rgb(var(--destructive) / 0.5) !important', backgroundColor: 'rgb(var(--destructive) / 0.07)' },
  '.cm-lp-mermaid': { textAlign: 'center', color: 'rgb(var(--muted-foreground))', fontSize: '0.85em' },
  '.cm-lp-mermaid svg': { margin: '0 auto', display: 'block' },
  '.cm-lp-table table': { margin: '0' },
  // The grid sizes to its content. The shared block containment would collapse the columns.
  '.cm-lp-grid-wrap': {
    position: 'relative', cursor: 'default', width: 'fit-content', maxWidth: '100%', contain: 'none',
    padding: '0 22px 22px 0', margin: '0 0 -6px',
  },
  '.cm-lp-grid-wrap table.cm-lp-grid': { margin: '0' },
  '.cm-lp-grid td, .cm-lp-grid th': { cursor: 'text', outline: 'none', minWidth: '5em' },
  // An empty cell keeps the height of a line of text.
  '.cm-lp-grid td:empty::before, .cm-lp-grid th:empty::before': { content: '"\\200b"' },
  '.cm-lp-grid td:focus, .cm-lp-grid th:focus': { boxShadow: 'inset 0 0 0 2px rgb(var(--primary))' },
  '.cm-lp-grid-add': {
    position: 'absolute', opacity: '0', border: '1px dashed rgb(var(--border))', borderRadius: '4px', color: 'rgb(var(--muted-foreground))',
    backgroundColor: 'rgb(var(--card))', fontSize: '13px', lineHeight: '1', cursor: 'pointer',
  },
  '.cm-lp-grid-wrap:hover .cm-lp-grid-add, .cm-lp-grid-active .cm-lp-grid-add': { opacity: '1' },
  '.cm-lp-grid-menu': {
    position: 'absolute', zIndex: '1', display: 'none', width: '18px', height: '18px', padding: '0', borderRadius: '9999px', fontSize: '11px', lineHeight: '1',
    color: 'rgb(var(--muted-foreground))', backgroundColor: 'rgb(var(--card))', border: '1px solid rgb(var(--border))', cursor: 'pointer',
  },
  '.cm-lp-grid-active .cm-lp-grid-menu': { display: 'block' },
  '.cm-lp-grid-menu:hover': { color: 'rgb(var(--primary))', borderColor: 'rgb(var(--primary) / 0.6)' },
  '.cm-lp-table-src': { fontFamily: 'var(--font-mono)', fontSize: '0.85em' },
  '.cm-lp-grid-add-row': { left: '0', right: '22px', bottom: '2px', height: '16px' },
  '.cm-lp-grid-add-col': { top: '0', bottom: '22px', right: '2px', width: '16px' },
  '.cm-lp-math': { textAlign: 'center' },
})

// Code inside fenced blocks takes the classes of the view's highlight.js colors. Markdown itself gets no style.
const liveHighlight = tagHighlighter([
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.modifier, tags.self], class: 'hljs-keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.attributeValue], class: 'hljs-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.typeName, tags.className, tags.standard(tags.variableName)], class: 'hljs-number' },
  { tag: [tags.lineComment, tags.blockComment, tags.docComment], class: 'hljs-comment' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.tagName], class: 'hljs-title' },
  { tag: [tags.propertyName, tags.attributeName], class: 'hljs-attr' },
  { tag: tags.deleted, class: 'hljs-deletion' },
  { tag: tags.inserted, class: 'hljs-addition' },
])

export function livePreview(): Extension {
  return [tableSource, liveField, liveTheme, syntaxHighlighting(liveHighlight), EditorView.editorAttributes.of({ class: 'cm-live' })]
}
