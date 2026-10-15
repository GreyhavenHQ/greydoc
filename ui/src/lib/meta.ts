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
  if (lines.length < 2 || !/^-{3,}$/.test(lines[0])) return { data: null, body: text, bodyLine: 0 }
  for (let i = 1; i < lines.length; i++) {
    if (/^-{1,2}$/.test(lines[i])) return { data: null, body: text, bodyLine: 0 }
    if (lines[i].length === lines[0].length && /^(?:-{3,}|\.{3,})$/.test(lines[i])) {
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
  }
  return { data: null, body: text, bodyLine: 0 }
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
