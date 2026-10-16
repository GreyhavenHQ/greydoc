import { sourceToRendered } from '@/render/sourceMap'

export interface PreviewThread {
  id: string
  from: number
  to: number
  active: boolean
}

interface Mark {
  start: number
  end: number
  id: string
  active: boolean
}

export function clearThreadMarks(article: HTMLElement) {
  const parents = new Set<Node>()
  for (const s of article.querySelectorAll('span.preview-thread')) {
    const parent = s.parentNode!
    parents.add(parent)
    s.replaceWith(...s.childNodes)
  }
  parents.forEach((p) => p.normalize())
  for (const b of article.querySelectorAll('.preview-thread-block')) {
    b.classList.remove('preview-thread-block', 'preview-thread-active')
    if (!b.classList.length) b.removeAttribute('class')
    b.removeAttribute('data-thread')
  }
}

// applyThreadMarks replaces the thread highlights of a rendered article. Ranges are indexes in source.
export function applyThreadMarks(article: HTMLElement, source: string, threads: PreviewThread[]) {
  clearThreadMarks(article)
  const byNode = new Map<Text, Mark[]>()
  for (const t of threads) {
    const { ranges, blocks } = sourceToRendered(article, t.from, t.to, source)
    for (const r of ranges) {
      const list = byNode.get(r.node) ?? []
      list.push({ start: r.start, end: r.end, id: t.id, active: t.active })
      byNode.set(r.node, list)
    }
    for (const b of blocks) {
      if (b.classList.contains('preview-thread-active')) continue
      b.classList.add('preview-thread-block')
      b.classList.toggle('preview-thread-active', t.active)
      b.dataset.thread = t.id
    }
  }
  byNode.forEach((marks, node) => wrap(node, marks))
}

// wrap splits a text node at every mark boundary and wraps each covered segment.
function wrap(node: Text, marks: Mark[]) {
  const cuts = [...new Set(marks.flatMap((m) => [m.start, m.end]))].sort((a, b) => b - a)
  let end = node.length
  const rest = node
  for (const cut of cuts) {
    if (cut <= 0 || cut >= end) continue
    const segment = rest.splitText(cut)
    mark(segment, cut, end, marks)
    end = cut
  }
  mark(rest, 0, end, marks)
}

function mark(segment: Text, start: number, end: number, marks: Mark[]) {
  const covering = marks.filter((m) => m.start <= start && m.end >= end)
  if (!covering.length) return
  const pick = covering.find((m) => m.active) ?? covering[covering.length - 1]
  const span = segment.ownerDocument.createElement('span')
  span.className = 'preview-thread' + (pick.active ? ' preview-thread-active' : '')
  span.dataset.thread = pick.id
  segment.replaceWith(span)
  span.append(segment)
}
