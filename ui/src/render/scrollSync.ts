import { EditorView } from '@codemirror/view'

// A Point maps a zero-based source line to a preview scroll position.
export interface Point {
  line: number
  y: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

// buildPoints sorts the anchors and keeps the longest run that never goes up, between the top and the bottom of the pane.
export function buildPoints(anchors: Point[], lineCount: number, maxY: number): Point[] {
  const sorted = anchors
    .map((p) => ({ line: clamp(p.line, 0, lineCount), y: clamp(p.y, 0, maxY) }))
    .sort((a, b) => a.line - b.line || a.y - b.y)
  const tails: number[] = []
  const prev: number[] = []
  sorted.forEach((p, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[tails[mid]].y <= p.y) lo = mid + 1
      else hi = mid
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1
    tails[lo] = i
  })
  const kept: Point[] = []
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) kept.unshift(sorted[i])
  const out: Point[] = []
  for (const p of [{ line: 0, y: 0 }, ...kept, { line: lineCount, y: maxY }]) {
    const last = out[out.length - 1]
    if (!last || last.line !== p.line || last.y !== p.y) out.push(p)
  }
  return out
}

function interpolate(points: Point[], value: number, from: keyof Point, to: keyof Point): number {
  let i = 0
  while (i + 1 < points.length && points[i + 1][from] <= value) i++
  const a = points[i]
  const b = points[i + 1]
  if (!b || value <= a[from]) return a[to]
  return a[to] + ((value - a[from]) / (b[from] - a[from])) * (b[to] - a[to])
}

export const yForLine = (points: Point[], line: number) => interpolate(points, line, 'line', 'y')
export const lineForY = (points: Point[], y: number) => interpolate(points, y, 'y', 'line')

// measure reads the top and the bottom of every rendered anchor, as scroll positions of pane.
export function measure(pane: HTMLElement, article: HTMLElement, lineCount: number): Point[] {
  const origin = article.getBoundingClientRect().top
  const anchors: Point[] = []
  for (const el of article.querySelectorAll<HTMLElement>('[data-line]')) {
    if (!el.getClientRects().length || el.checkVisibility?.() === false) continue
    const r = el.getBoundingClientRect()
    anchors.push({ line: Number(el.dataset.line), y: r.top - origin })
    if (el.dataset.lineEnd) anchors.push({ line: Number(el.dataset.lineEnd), y: r.bottom - origin })
  }
  return buildPoints(anchors, lineCount, pane.scrollHeight - pane.clientHeight)
}

export const atBottom = (el: HTMLElement) => el.scrollTop > 0 && el.scrollTop >= el.scrollHeight - el.clientHeight - 1

// editorTopLine is the source line at the top of the editor, with the part of it scrolled past as a fraction.
export function editorTopLine(view: EditorView): number {
  const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop
  if (top <= 0) return 0
  const block = view.lineBlockAtHeight(top)
  const first = view.state.doc.lineAt(block.from).number - 1
  const count = view.state.doc.lineAt(block.to).number - first
  return first + (block.height ? clamp((top - block.top) / block.height, 0, 1) : 0) * count
}

// scrollEditorToLine puts a fractional source line at the top of the editor. The line count scrolls to the end.
// CodeMirror scrolls to the line in its measure phase, where lines outside the viewport get their real height.
// The fraction is added in the next frame, when the line is measured.
export function scrollEditorToLine(view: EditorView, line: number) {
  const doc = view.state.doc
  if (line >= doc.lines) {
    view.dispatch({ effects: EditorView.scrollIntoView(doc.length, { y: 'end', yMargin: 0 }) })
    return
  }
  const from = doc.line(clamp(Math.floor(line), 0, doc.lines - 1) + 1).from
  view.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 0 }) })
  requestAnimationFrame(() => {
    if (!view.dom.isConnected) return
    const scroller = view.scrollDOM
    const block = view.lineBlockAt(from)
    const first = doc.lineAt(block.from).number - 1
    const count = doc.lineAt(block.to).number - first
    const offset = view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTop = offset + block.top + clamp((line - first) / count, 0, 1) * block.height
  })
}
