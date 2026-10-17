// Rendered content with no character-level source: math, diagrams and generated labels.
const OPAQUE = '.katex, .mermaid-block, svg, .alert-title, nav.toc'

const WINDOW = 200
const WS_WINDOW = 32

const isWs = (c: string) => /\s/.test(c)
const same = (a: string, b: string) => (isWs(a) ? isWs(b) : a.toLowerCase() === b.toLowerCase())

export function lineStarts(source: string): number[] {
  const out = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') out.push(i + 1)
  return out
}

// skipSyntax returns the source index after Markdown that renders no text, starting at j.
function skipSyntax(source: string, j: number, c: string, afterOpaque: boolean): number {
  for (;;) {
    const rest = source.slice(j, j + WINDOW * 4)
    const m =
      /^\]\([^)\n]*\)/.exec(rest) ?? (c !== '!' ? /^!\[[^\]\n]*\]\([^)\n]*\)/.exec(rest) : null) ?? (afterOpaque ? /^\$\$?[^$]+\$\$?/.exec(rest) : null)
    if (!m) return j
    j += m[0].length
  }
}

// align maps each rendered character to a source index, or -1 when it has no match.
export function align(rendered: string, source: string, skip: boolean[]): number[] {
  const map = new Array<number>(rendered.length).fill(-1)
  let j = 0
  let afterOpaque = false
  for (let i = 0; i < rendered.length; i++) {
    if (skip[i]) {
      afterOpaque = true
      continue
    }
    const c = rendered[i]
    if (!same(c, source[j] ?? '')) j = skipSyntax(source, j, c, afterOpaque)
    afterOpaque = false
    const end = Math.min(source.length, j + (isWs(c) ? WS_WINDOW : WINDOW))
    for (let k = j; k < end; k++) {
      if (same(c, source[k])) {
        map[i] = k
        j = k + 1
        break
      }
    }
  }
  return map
}

interface Context {
  source: string
  starts: number[]
  lines: number[]
}

interface Unit {
  el: HTMLElement
  nodes: Text[]
  offsets: number[]
  text: string
  skip: boolean[]
  map: number[]
  from: number
  to: number
}

function context(article: HTMLElement, source: string): Context {
  const lines = [...new Set(Array.from(article.querySelectorAll<HTMLElement>('[data-line]'), (el) => Number(el.dataset.line)))]
  return { source, starts: lineStarts(source), lines: lines.sort((a, b) => a - b) }
}

// span is the source of a block: from its line to the next block's line, without trailing blank lines.
function span(ctx: Context, el: HTMLElement): { from: number; to: number } {
  const line = Number(el.dataset.line)
  const next = ctx.lines.find((l) => l > line)
  const from = ctx.starts[line] ?? ctx.source.length
  let to = next == null ? ctx.source.length : (ctx.starts[next] ?? ctx.source.length)
  while (to > from && isWs(ctx.source[to - 1])) to--
  return { from, to }
}

// unit collects the text of a block that belongs to no inner block, and aligns it to the block's source.
function unit(ctx: Context, el: HTMLElement): Unit {
  const nodes: Text[] = []
  const offsets: number[] = []
  const skip: boolean[] = []
  let text = ''
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (n.parentElement?.closest('[data-line]') !== el) continue
    const opaque = Boolean(n.parentElement.closest(OPAQUE))
    nodes.push(n)
    offsets.push(text.length)
    text += n.data
    for (let i = 0; i < n.length; i++) skip.push(opaque)
  }
  const { from, to } = span(ctx, el)
  return { el, nodes, offsets, text, skip, map: align(text, ctx.source.slice(from, to), skip), from, to }
}

function blockOf(article: HTMLElement, node: Node): HTMLElement | null {
  const el = node instanceof Element ? node : node.parentElement
  const b = el?.closest<HTMLElement>('[data-line]')
  return b && article.contains(b) ? b : null
}

// offsetIn returns the index in the unit's text of a DOM boundary point.
function offsetIn(u: Unit, container: Node, offset: number): number {
  const point = container.ownerDocument!.createRange()
  point.setStart(container, offset)
  for (let i = 0; i < u.nodes.length; i++) {
    if (u.nodes[i] === container) return u.offsets[i] + offset
    if (point.comparePoint(u.nodes[i], 0) >= 0) return u.offsets[i]
  }
  return u.text.length
}

// visibleText is the selected text with each formula as its TeX source instead of its MathML and glyphs.
function visibleText(range: Range): string {
  const frag = range.cloneContents()
  for (const k of frag.querySelectorAll('.katex')) {
    // The sanitizer drops <annotation> but keeps its TeX as text directly under <math>.
    const math = k.querySelector('math')
    const tex = math ? Array.from(math.childNodes, (n) => (n.nodeType === Node.TEXT_NODE ? n.textContent : '')).join('').trim() : ''
    k.replaceWith(tex || (k.querySelector('.katex-html')?.textContent ?? ''))
  }
  return frag.textContent ?? ''
}

export interface SourceSelection {
  from: number
  to: number
  // exact is false when the anchor covers whole blocks because the text did not match.
  exact: boolean
  quote: string
}

// selectionToSource maps a DOM range in the rendered article to a range of the Markdown source.
export function selectionToSource(article: HTMLElement, range: Range, source: string): SourceSelection | null {
  const a = blockOf(article, range.startContainer)
  const b = blockOf(article, range.endContainer)
  if (!a || !b) return null
  const ctx = context(article, source)
  const ua = unit(ctx, a)
  const ub = a === b ? ua : unit(ctx, b)

  let exact = true
  for (const el of article.querySelectorAll<HTMLElement>('[data-line]')) {
    if (!range.intersectsNode(el)) continue
    const u = el === a ? ua : el === b ? ub : unit(ctx, el)
    const s = offsetIn(u, range.startContainer, range.startOffset)
    const e = offsetIn(u, range.endContainer, range.endOffset)
    for (let i = s; i < e && exact; i++) if (!isWs(u.text[i]) && (u.skip[i] || u.map[i] < 0)) exact = false
    if (!exact) break
  }
  let i = offsetIn(ua, range.startContainer, range.startOffset)
  while (i < ua.text.length && isWs(ua.text[i])) i++
  let k = offsetIn(ub, range.endContainer, range.endOffset) - 1
  while (k >= 0 && isWs(ub.text[k])) k--
  if (exact && i < ua.text.length && k >= 0) {
    const from = ua.from + ua.map[i]
    const to = ub.from + ub.map[k] + 1
    if (from < to) return { from, to, exact: true, quote: source.slice(from, to) }
  }
  const from = Math.min(ua.from, ub.from)
  const to = Math.max(ua.to, ub.to)
  return from < to ? { from, to, exact: false, quote: visibleText(range) } : null
}

export interface RenderedPiece {
  node: Text
  start: number
  end: number
}

// sourceToRendered finds the rendered text of a source range, or the whole blocks when the text does not match.
export function sourceToRendered(article: HTMLElement, from: number, to: number, source: string): { ranges: RenderedPiece[]; blocks: HTMLElement[] } {
  const ctx = context(article, source)
  const ranges: RenderedPiece[] = []
  const blocks: HTMLElement[] = []
  for (const el of article.querySelectorAll<HTMLElement>('[data-line]')) {
    const s = span(ctx, el)
    if (!(s.from < to && from < s.to)) continue
    const u = unit(ctx, el)
    let lo = -1
    let hi = -1
    for (let i = 0; i < u.text.length; i++) {
      const at = u.from + u.map[i]
      if (u.map[i] >= 0 && at >= from && at < to) {
        if (lo < 0) lo = i
        hi = i
      }
    }
    if (lo < 0) {
      if (/\S/.test(u.text)) blocks.push(el)
      continue
    }
    u.nodes.forEach((node, n) => {
      const start = Math.max(lo, u.offsets[n])
      const end = Math.min(hi + 1, u.offsets[n] + node.length)
      if (start < end && !u.skip[start] && /\S/.test(node.data)) ranges.push({ node, start: start - u.offsets[n], end: end - u.offsets[n] })
    })
  }
  return { ranges, blocks }
}
