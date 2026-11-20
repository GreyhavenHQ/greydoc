import type { ChangeSpec, Text } from '@codemirror/state'

// A Markdown table as cell spans in the text. Edits change spans, so they touch only the cells they edit.

export type Align = 'left' | 'right' | 'center' | ''

export interface Cell {
  // text is the source of the cell, trimmed. from and to are its absolute span.
  text: string
  from: number
  to: number
  // start is just after the pipe before the cell, end is the pipe after it, or the end of the row.
  start: number
  end: number
  // raw runs to rawTo and keeps the spaces a person typed at the end. One space before the pipe stays padding.
  raw: string
  rawTo: number
}

export interface Row {
  from: number
  to: number
  cells: Cell[]
  // closed says whether the row ends with a pipe.
  closed: boolean
}

export interface Table {
  from: number
  to: number
  header: Row
  delim: Row
  body: Row[]
  align: Align[]
}

export function splitRow(line: string, from: number): Row {
  const cells: Cell[] = []
  let i = 0
  while (i < line.length && /\s/.test(line[i])) i++
  if (line[i] === '|') i++
  let start = i
  const push = (end: number) => {
    let a = start
    let b = end
    while (a < b && /\s/.test(line[a])) a++
    while (b > a && /\s/.test(line[b - 1])) b--
    if (a === b) a = b = Math.min(start + 1, end)
    const rawTo = end > a && /\s/.test(line[end - 1]) ? end - 1 : end
    cells.push({ text: line.slice(a, b), from: from + a, to: from + b, start: from + start, end: from + end, raw: line.slice(a, rawTo), rawTo: from + rawTo })
  }
  for (; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === '|') {
      push(i)
      start = i + 1
    }
  }
  const closed = line.slice(start).trim() === ''
  if (!closed) push(line.length)
  return { from, to: from + line.length, cells, closed }
}

const delimRe = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

// parseTable reads the table whose header is the line at pos.
export function parseTable(doc: Text, pos: number): Table | null {
  const first = doc.lineAt(pos)
  if (first.number >= doc.lines) return null
  const delimLine = doc.line(first.number + 1)
  if (!delimRe.test(delimLine.text) || !first.text.includes('|')) return null
  const header = splitRow(first.text, first.from)
  const delim = splitRow(delimLine.text, delimLine.from)
  const align = delim.cells.map((c): Align => {
    const l = c.text.startsWith(':')
    const r = c.text.endsWith(':')
    return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
  })
  const body: Row[] = []
  for (let n = delimLine.number + 1; n <= doc.lines; n++) {
    const l = doc.line(n)
    if (!l.text.includes('|') || l.text.trim() === '') break
    body.push(splitRow(l.text, l.from))
  }
  return { from: first.from, to: (body.at(-1) ?? delim).to, header, delim, body, align }
}

// rowAt counts the header as row 0 and the body from 1.
const rowAt = (t: Table, row: number) => (row === 0 ? t.header : t.body[row - 1])

export const escapeCell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
export const unescapeCell = (s: string) => s.replace(/\\\|/g, '|')

// cellText is the text a person edits: escaped pipes show as plain pipes.
export const cellText = (t: Table, row: number, col: number) => unescapeCell(rowAt(t, row)?.cells[col]?.text ?? '')

// cellRaw is cellText with the spaces typed at its end, which the source keeps until the next edit.
export const cellRaw = (t: Table, row: number, col: number) => unescapeCell(rowAt(t, row)?.cells[col]?.raw ?? '')

// setCell sets the text of one cell. Only the differing middle part of the cell changes.
export function setCell(t: Table, row: number, col: number, text: string): ChangeSpec {
  const r = rowAt(t, row)
  const next = escapeCell(text)
  const c = r.cells[col]
  if (!c) {
    const last = r.cells.at(-1)
    const at = last && r.closed ? last.end + 1 : r.to
    const open = r.closed ? '' : ' |'
    return { from: at, insert: open + '  |'.repeat(col - r.cells.length) + ' ' + next + ' |' }
  }
  const old = c.raw
  let p = 0
  while (p < old.length && p < next.length && old[p] === next[p]) p++
  let s = 0
  while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++
  return { from: c.from + p, to: c.rawTo - s, insert: next.slice(p, next.length - s) }
}

// addRow adds an empty row after the given row. Row 0 is the header.
export function addRow(t: Table, after: number): ChangeSpec {
  const r = after === 0 ? t.delim : t.body[after - 1]
  return { from: r.to, insert: '\n|' + '  |'.repeat(t.header.cells.length) }
}

export function removeRow(t: Table, row: number): ChangeSpec | null {
  if (row < 1 || row > t.body.length) return null
  const r = t.body[row - 1]
  return { from: r.from - 1, to: r.to }
}

// addColumn inserts an empty column before column at. at equal to the column count appends one.
export function addColumn(t: Table, at: number): ChangeSpec[] {
  const out: ChangeSpec[] = []
  for (const r of [t.header, t.delim, ...t.body]) {
    const x = r === t.delim ? '---' : ''
    const c = r.cells[at]
    if (c) {
      out.push(c.start > r.from || at > 0 ? { from: c.start, insert: ` ${x} |` } : { from: c.start, insert: `${x} | ` })
    } else if (at >= t.header.cells.length) {
      const last = r.cells.at(-1)
      out.push(last && r.closed ? { from: last.end + 1, insert: ` ${x} |` } : { from: r.to, insert: ` | ${x} |` })
    }
  }
  return out
}

export function removeColumn(t: Table, col: number): ChangeSpec[] | null {
  if (t.header.cells.length < 2) return null
  const out: ChangeSpec[] = []
  for (const r of [t.header, t.delim, ...t.body]) {
    const c = r.cells[col]
    if (!c) continue
    if (col > 0) out.push({ from: r.cells[col - 1].end, to: c.end })
    else if (r.cells[1]) out.push({ from: c.start, to: r.cells[1].start })
  }
  return out
}

const delimFor = (a: Align, w: number) =>
  a === 'center' ? ':' + '-'.repeat(w - 2) + ':' : a === 'right' ? '-'.repeat(w - 1) + ':' : a === 'left' ? ':' + '-'.repeat(w - 1) : '-'.repeat(w)

export function setAlign(t: Table, col: number, align: Align): ChangeSpec {
  const c = t.delim.cells[col]
  return { from: c.from, to: c.to, insert: { center: ':---:', right: '---:', left: ':---', '': '---' }[align] }
}

// tidy pads every column to its widest cell. It rewrites every row, so it runs only on demand.
export function tidy(t: Table): ChangeSpec {
  const n = t.header.cells.length
  const rows = [t.header, ...t.body].map((r) => Array.from({ length: n }, (_, i) => r.cells[i]?.text ?? ''))
  const width = Array.from({ length: n }, (_, i) => Math.max(3, ...rows.map((r) => r[i].length)))
  const pad = (s: string, i: number) => {
    const gap = width[i] - s.length
    const a = t.align[i]
    if (a === 'right') return ' '.repeat(gap) + s
    if (a === 'center') return ' '.repeat(gap >> 1) + s + ' '.repeat(gap - (gap >> 1))
    return s + ' '.repeat(gap)
  }
  const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |'
  const out = [line(rows[0].map(pad)), line(width.map((w, i) => delimFor(t.align[i] ?? '', w))), ...rows.slice(1).map((r) => line(r.map(pad)))]
  return { from: t.from, to: t.to, insert: out.join('\n') }
}
