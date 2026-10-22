import { load as loadYaml } from 'js-yaml'

export interface FrontMatter {
  title?: string
  description?: string
  tags?: string[]
  type?: string
  slideOptions?: Record<string, unknown>
  [key: string]: unknown
}

// splitFrontMatter mirrors internal/notemeta: 3+ dashes, closed by the same count of dashes or dots.
export function splitFrontMatter(text: string): { data: FrontMatter | null; body: string; bodyLine: number } {
  const lines = text.split('\n')
  const i = closingLine(lines)
  if (i < 0) return { data: null, body: text, bodyLine: 0 }
  let data: FrontMatter | null = null
  try {
    const parsed = loadYaml(lines.slice(1, i).join('\n'))
    if (parsed && typeof parsed === 'object') data = parsed as FrontMatter
  } catch {
    data = null
  }
  if (data && typeof data.tags === 'string') {
    data.tags = (data.tags as string).split(',').map((t) => t.trim()).filter(Boolean)
  } else if (data && Array.isArray(data.tags)) {
    data.tags = data.tags.map((t) => String(t).trim()).filter(Boolean)
  }
  return { data, body: lines.slice(i + 1).join('\n'), bodyLine: i + 1 }
}

// closingLine returns the index of the line that closes the front matter, or -1.
function closingLine(lines: string[]): number {
  if (lines.length < 2 || !/^-{3,}$/.test(lines[0])) return -1
  for (let i = 1; i < lines.length; i++) {
    if (/^-{1,2}$/.test(lines[i])) return -1
    if (lines[i].length === lines[0].length && /^(?:-{3,}|\.{3,})$/.test(lines[i])) return i
  }
  return -1
}

export type DocWidth = 'normal' | 'wide'

// docWidthPx is the text column width. Normal matches HedgeDoc.
export const docWidthPx: Record<DocWidth, number> = { normal: 728, wide: 1200 }

export function docWidth(text: string): DocWidth {
  const w = splitFrontMatter(text.slice(0, 8192)).data?.width
  return typeof w === 'string' && w.trim().toLowerCase() === 'wide' ? 'wide' : 'normal'
}

// widthEdit returns the smallest text change that sets or clears width: wide, or null when none is needed.
export function widthEdit(text: string, wide: boolean): { from: number; to: number; insert: string } | null {
  if ((docWidth(text) === 'wide') === wide) return null
  const lines = text.split('\n')
  const close = closingLine(lines)
  const offset = (n: number) => lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0)
  if (close < 0) return wide ? { from: 0, to: 0, insert: '---\nwidth: wide\n---\n' } : null
  const at = lines.findIndex((l, i) => i > 0 && i < close && /^width\s*:/.test(l))
  if (wide) {
    if (at > 0) return { from: offset(at), to: offset(at) + lines[at].length, insert: 'width: wide' }
    return { from: offset(close), to: offset(close), insert: 'width: wide\n' }
  }
  if (at < 0) return null
  if (lines.slice(1, close).every((l, j) => j + 1 === at || !l.trim())) {
    return { from: 0, to: Math.min(text.length, offset(close + 1)), insert: '' }
  }
  return { from: offset(at), to: offset(at + 1), insert: '' }
}

// isSlides mirrors notemeta: front matter type: slide marks a presentation. Only the head is read, so it is cheap per render.
export function isSlides(text: string): boolean {
  const t = splitFrontMatter(text.slice(0, 8192)).data?.type
  return typeof t === 'string' && ['slide', 'slides'].includes(t.trim().toLowerCase())
}

export function extractTitle(text: string): string {
  const { data, body } = splitFrontMatter(text)
  if (data?.title) return String(data.title).trim()
  let fence = false
  for (const line of body.split('\n')) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) fence = !fence
    if (fence) continue
    const m = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (m && m[1]) return m[1].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]+/g, '').trim()
  }
  return ''
}
