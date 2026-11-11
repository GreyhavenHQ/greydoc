import { EditorSelection, Prec, type ChangeSpec, type EditorState, type Extension, type StateCommand, type Transaction } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { slugify } from '@/render/plugins'
import { keymap, type EditorView, type KeyBinding } from '@codemirror/view'

const userEvent = 'input.format'

// fits tells whether a run of marker characters closes this marker: * is a run of 1 or 3, ** a run of 2 or more.
function fits(marker: string, run: number): boolean {
  if (marker === '*' || marker === '~') return run === 1 || run === 3
  return run >= marker.length
}

function countRun(s: string, ch: string, fromEnd = false): number {
  let n = 0
  while (n < s.length && s[fromEnd ? s.length - 1 - n : n] === ch) n++
  return n
}

// toggleWrap wraps each selection range in marker, or removes marker when the range is already wrapped.
export function toggleWrap(marker: string): StateCommand {
  const n = marker.length
  const ch = marker[0]
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const tr = state.changeByRange((r) => {
      const before = state.sliceDoc(Math.max(0, r.from - 4), r.from)
      const after = state.sliceDoc(r.to, r.to + 4)
      if (fits(marker, countRun(before, ch, true)) && fits(marker, countRun(after, ch))) {
        return {
          changes: [
            { from: r.from - n, to: r.from },
            { from: r.to, to: r.to + n },
          ],
          range: EditorSelection.range(r.anchor - n, r.head - n),
        }
      }
      const text = state.sliceDoc(r.from, r.to)
      const lead = countRun(text, ch)
      if (text.length >= 2 * n && lead < text.length && fits(marker, lead) && fits(marker, countRun(text, ch, true))) {
        const end = (p: number) => (p === r.from ? p : p - 2 * n)
        return {
          changes: [
            { from: r.from, to: r.from + n },
            { from: r.to - n, to: r.to },
          ],
          range: EditorSelection.range(end(r.anchor), end(r.head)),
        }
      }
      return {
        changes: [
          { from: r.from, insert: marker },
          { from: r.to, insert: marker },
        ],
        range: EditorSelection.range(r.anchor + n, r.head + n),
      }
    })
    dispatch(state.update(tr, { scrollIntoView: true, userEvent }))
    return true
  }
}

// touchedLines lists the lines under the selection. A range that ends at the start of a line leaves that line out.
function touchedLines(state: EditorState): number[] {
  const out = new Set<number>()
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    let last = state.doc.lineAt(r.to).number
    if (last > first && r.to === state.doc.line(last).from) last--
    for (let l = first; l <= last; l++) out.add(l)
  }
  return [...out].sort((a, b) => a - b)
}

function targetLines(state: EditorState): number[] {
  const all = touchedLines(state)
  const full = all.filter((l) => state.doc.line(l).text.trim() !== '')
  return full.length ? full : all
}

function applyLines(state: EditorState, dispatch: (tr: Transaction) => void, changes: ChangeSpec[]) {
  const set = state.changes(changes)
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => EditorSelection.range(set.mapPos(r.anchor, 1), set.mapPos(r.head, 1))),
    state.selection.mainIndex,
  )
  dispatch(state.update({ changes: set, selection, scrollIntoView: true, userEvent }))
}

export type ListKind = 'bullet' | 'ordered' | 'task'

const listPrefix = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] )?/
const isKind: Record<ListKind, RegExp> = {
  bullet: /^[-*+] $/,
  task: /^[-*+] \[[ xX]\] $/,
  ordered: /^\d+[.)] $/,
}

// toggleList puts a list prefix on every touched line, or removes it when all lines have it.
export function toggleList(kind: ListKind): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const lines = targetLines(state).map((l) => {
      const line = state.doc.line(l)
      const m = listPrefix.exec(line.text)!
      return { from: line.from + m[1].length, prefix: m[2] ?? '' }
    })
    const all = lines.every((l) => isKind[kind].test(l.prefix))
    const changes = lines.map((l, i) => {
      if (all) return { from: l.from, to: l.from + l.prefix.length }
      if (kind === 'task' && isKind.task.test(l.prefix)) return { from: l.from }
      const insert = kind === 'bullet' ? '- ' : kind === 'task' ? '- [ ] ' : `${i + 1}. `
      return { from: l.from, to: l.from + l.prefix.length, insert }
    })
    applyLines(state, dispatch, changes)
    return true
  }
}

const headingPrefix = /^ {0,3}(#{1,6})(?:[ \t]+|$)/

// setHeading makes every touched line a heading of level, or plain text for level 0 or when all lines have that level.
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const lines = targetLines(state).map((l) => {
      const line = state.doc.line(l)
      const m = headingPrefix.exec(line.text)
      return { from: line.from, len: m ? m[0].length : 0, level: m ? m[1].length : 0 }
    })
    const off = level === 0 || lines.every((l) => l.level === level)
    const insert = off ? '' : '#'.repeat(level) + ' '
    applyLines(
      state,
      dispatch,
      lines.map((l) => ({ from: l.from, to: l.from + l.len, insert })),
    )
    return true
  }
}

// toggleQuote quotes every touched line, or unquotes them when all are quoted.
export const toggleQuote: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false
  const lines = targetLines(state).map((l) => state.doc.line(l))
  const quoted = (t: string) => /^>\s?/.exec(t)
  const all = lines.every((l) => quoted(l.text))
  applyLines(
    state,
    dispatch,
    lines.map((l) => (all ? { from: l.from, to: l.from + quoted(l.text)![0].length } : { from: l.from, insert: '> ' })),
  )
  return true
}

// insertBlock puts a block of text on its own lines and leaves the cursor at §.
export function insertBlock(text: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const line = state.doc.lineAt(state.selection.main.head)
    const pre = line.length ? '\n\n' : ''
    const at = line.length ? line.to : line.from
    const i = Math.max(text.indexOf('§'), 0)
    const after = state.sliceDoc(at, at + 2)
    const blank = after === '\n\n' || (after === '\n' && at + 1 === state.doc.length)
    const body = blank && text.endsWith('\n') ? text.slice(0, -1) : text
    dispatch(
      state.update({
        changes: { from: at, insert: pre + body.replace('§', '') },
        selection: { anchor: at + pre.length + i },
        scrollIntoView: true,
        userEvent,
      }),
    )
    return true
  }
}

// insertFootnote puts the next footnote number at the cursor and its note at the end, with the cursor in the note.
export const insertFootnote: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false
  const text = state.doc.toString()
  const used = [...text.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1]))
  const n = Math.max(0, ...used) + 1
  const at = state.selection.main.head
  const notes = /\n\[\^\d+\]: /.test(text)
  const end = text.endsWith('\n') ? '' : '\n'
  const note = (notes ? end : end + '\n') + `[^${n}]: `
  const ref = `[^${n}]`
  dispatch(
    state.update({
      changes: [
        { from: at, insert: ref },
        { from: text.length, insert: note },
      ],
      selection: { anchor: text.length + ref.length + note.length },
      scrollIntoView: true,
      userEvent,
    }),
  )
  return true
}

export interface FormatState {
  bold: boolean
  italic: boolean
  strike: boolean
  code: boolean
  link: boolean
  quote: boolean
  // block is p or h1 to h6.
  block: string
  list: ListKind | null
}

// formatState reads the formatting at the main cursor, for the toolbar.
export function formatState(state: EditorState): FormatState {
  const head = state.selection.main.head
  const names = new Set<string>()
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(head, -1); n; n = n.parent) names.add(n.name)
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(head, 1); n; n = n.parent) {
    if (n.name === 'StrongEmphasis' || n.name === 'Emphasis' || n.name === 'Link' || n.name === 'InlineCode') names.add(n.name)
  }
  const text = state.doc.lineAt(head).text
  const h = headingPrefix.exec(text)
  const item = /^\s*(?:>\s?)*\s*([-*+] \[[ xX]\] |[-*+] |\d+[.)] )/.exec(text)
  const list = item ? (isKind.task.test(item[1]) ? 'task' : isKind.ordered.test(item[1]) ? 'ordered' : 'bullet') : null
  return {
    bold: names.has('StrongEmphasis'),
    italic: names.has('Emphasis'),
    strike: names.has('Strikethrough'),
    code: names.has('InlineCode'),
    link: names.has('Link'),
    quote: names.has('Blockquote') || /^\s*>/.test(text),
    block: h ? 'h' + h[1].length : 'p',
    list,
  }
}

export interface LinkInfo {
  from: number
  to: number
  text: string
  url: string
}

// linkAt finds the [text](url) link around the main cursor.
export function linkAt(state: EditorState): LinkInfo | null {
  const head = state.selection.main.head
  for (const side of [-1, 1] as const) {
    for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(head, side); n; n = n.parent) {
      if (n.name !== 'Link') continue
      const marks = n.getChildren('LinkMark')
      const url = n.getChild('URL')
      if (marks.length < 2 || !url) return null
      return { from: n.from, to: n.to, text: state.sliceDoc(marks[0].to, marks[1].from), url: state.sliceDoc(url.from, url.to) }
    }
  }
  return null
}

// linkMarkdown is [text](url), or the text alone without an address.
export function linkMarkdown(text: string, url: string): string {
  const label = text.replace(/[[\]]/g, '') || url
  return url ? `[${label}](${url.replace(/[()\s]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))})` : label
}

export interface LinkTargetInfo {
  from: number
  to: number
  url: string
  // note is a link to another document. editable says whether the link popover can change it.
  note: boolean
  editable: boolean
}

// linkInfoAt finds what a click at pos would open: a link, a bare address or a [[link]] to a document.
export function linkInfoAt(state: EditorState, pos: number): LinkTargetInfo | null {
  const line = state.doc.lineAt(pos)
  for (const m of line.text.matchAll(/\[\[([A-Za-z0-9_-]{1,64})(?:#([^\]|\n]+))?(?:\|[^\]\n]+)?\]\]/g)) {
    const from = line.from + m.index!
    const to = from + m[0].length
    if (pos < from || pos > to || m[1].toLowerCase() === 'toc') continue
    return { from, to, url: '/n/' + m[1].toLowerCase() + (m[2] ? '#' + slugify(m[2]) : ''), note: true, editable: false }
  }
  for (const side of [-1, 1] as const) {
    for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'Link') {
        const url = n.getChild('URL')
        if (url) return { from: n.from, to: n.to, url: state.sliceDoc(url.from, url.to), note: false, editable: true }
      }
      if (n.name === 'Autolink' || (n.name === 'URL' && !['Link', 'Image', 'Autolink'].includes(n.parent?.name ?? ''))) {
        return { from: n.from, to: n.to, url: state.sliceDoc(n.from, n.to).replace(/^<|>$/g, ''), note: false, editable: false }
      }
    }
  }
  return null
}

// linkChange sets the link at the cursor, or makes one of the selection. An empty url removes the link and keeps its text.
export function linkChange(state: EditorState, text: string, url: string) {
  const link = linkAt(state)
  const { from, to } = link ?? state.selection.main
  const insert = linkMarkdown(text, url)
  return { changes: { from, to, insert }, selection: { anchor: from + insert.length }, scrollIntoView: true, userEvent }
}

// insertLink turns each range into [text](url) with url selected, or a selected address into [](address).
export const insertLink: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false
  const tr = state.changeByRange((r) => {
    const text = state.sliceDoc(r.from, r.to)
    if (!text || /^https?:\/\/\S+$/.test(text)) {
      const insert = `[](${text || 'url'})`
      return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + 1) }
    }
    const url = r.from + text.length + 3
    return { changes: { from: r.from, to: r.to, insert: `[${text}](url)` }, range: EditorSelection.range(url, url + 3) }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent }))
  return true
}

// formatKeymap binds the formatting keys. It runs before the default keymap, which binds Mod-i to selectParentSyntax.
// onLink, when set, opens a link editor instead of writing the Markdown of a link.
export function formatKeymap(opts: { onComment: (from: number, to: number) => void; onLink?: (view: EditorView) => boolean }): Extension {
  const bindings: KeyBinding[] = [
    { key: 'Mod-b', run: toggleWrap('**') },
    { key: 'Mod-i', run: toggleWrap('*') },
    { key: 'Mod-u', run: toggleWrap('++') },
    { key: 'Mod-Shift-x', run: toggleWrap('~~') },
    { key: 'Mod-Shift-h', run: toggleWrap('==') },
    { key: 'Mod-e', run: toggleWrap('`') },
    { key: 'Mod-.', run: toggleWrap('^') },
    { key: 'Mod-,', run: toggleWrap('~') },
    { key: 'Mod-k', run: (view) => (opts.onLink && !view.state.readOnly ? opts.onLink(view) : insertLink(view)) },
    ...[0, 1, 2, 3, 4, 5, 6].map((n) => ({ key: `Mod-Alt-${n}`, run: setHeading(n) })),
    { key: 'Mod-Shift-7', run: toggleList('ordered') },
    { key: 'Mod-Shift-8', run: toggleList('bullet') },
    { key: 'Mod-Shift-9', run: toggleList('task') },
    {
      key: 'Mod-Alt-m',
      run: (view) => {
        const { from, to, empty } = view.state.selection.main
        if (empty) return false
        opts.onComment(from, to)
        return true
      },
    },
    { key: 'Mod-s', run: () => true },
  ]
  return Prec.high(keymap.of(bindings))
}
