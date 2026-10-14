import { splitFrontMatter } from '@/lib/meta'

export interface Slide {
  body: string
  notes: string
  vertical: { body: string; notes: string }[]
}

function withNotes(text: string): { body: string; notes: string } {
  const m = /^\s*note:\s*$/im.exec(text) ?? /^note:/im.exec(text)
  if (!m) return { body: text, notes: '' }
  return { body: text.slice(0, m.index), notes: text.slice(m.index).replace(/^\s*note:\s*/i, '') }
}

// splitSlides follows HedgeDoc: --- starts a new slide, ---- a vertical one. Fences are respected.
export function splitSlides(text: string): Slide[] {
  const { body } = splitFrontMatter(text)
  const slides: Slide[] = []
  let cur: string[] = []
  let vert: string[][] = []
  let fence = ''
  const flush = () => {
    const parts = [cur, ...vert].map((l) => withNotes(l.join('\n')))
    slides.push({ ...parts[0], vertical: parts.length > 1 ? parts : [] })
    cur = []
    vert = []
  }
  for (const line of body.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)
    if (f) fence = fence ? (line.trim().startsWith(fence) ? '' : fence) : f[1]
    if (!fence && /^---\s*$/.test(line)) {
      flush()
      continue
    }
    if (!fence && /^----\s*$/.test(line)) {
      vert.push([])
      continue
    }
    ;(vert.length ? vert[vert.length - 1] : cur).push(line)
  }
  flush()
  return slides
}
