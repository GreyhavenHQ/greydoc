import type { MarkdownIt, StateCore, StateInline, Token } from 'markdown-it'

export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
}

// sourceLines puts data-line on block tokens, for scroll sync and comment anchoring.
export function sourceLines(md: MarkdownIt, offset: () => number) {
  md.core.ruler.push('source_lines', (state: StateCore) => {
    for (const t of state.tokens) {
      const block = t.level === 0 && (t.nesting === 1 || t.type === 'fence' || t.type === 'code_block' || t.type === 'hr' || t.type === 'html_block')
      // List items at any depth carry their line too, so a task box can be toggled in the source.
      if (t.map && (block || t.type === 'list_item_open')) {
        t.attrSet('data-line', String(t.map[0] + offset()))
      }
    }
  })
}

// toc replaces a paragraph holding [toc] or [[toc]] with links to every heading.
export function toc(md: MarkdownIt) {
  md.core.ruler.push('toc', (state: StateCore) => {
    const tokens = state.tokens
    const headings: { level: number; text: string; id: string }[] = []
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type === 'heading_open') {
        const id = String(tokens[i].attrGet('id') ?? slugify(tokens[i + 1].content))
        headings.push({ level: Number(tokens[i].tag.slice(1)), text: tokens[i + 1].children?.map((c) => c.content).join('') ?? '', id })
      }
    }
    for (let i = 0; i + 2 < tokens.length; i++) {
      if (tokens[i].type === 'paragraph_open' && tokens[i + 2].type === 'paragraph_close' && /^\[\[?toc\]?\]$/i.test(tokens[i + 1].content.trim())) {
        const t = new state.Token('html_block', '', 0)
        const min = Math.min(...headings.map((h) => h.level), 6)
        const items = headings
          .map((h) => `<li class="toc-l${h.level - min}"><a href="#${md.utils.escapeHtml(h.id)}">${md.utils.escapeHtml(h.text)}</a></li>`)
          .join('')
        t.content = `<nav class="toc"><ul>${items}</ul></nav>\n`
        t.map = tokens[i].map
        tokens.splice(i, 3, t)
      }
    }
  })
}

const alertTypes = ['note', 'tip', 'important', 'warning', 'caution']

// githubAlerts turns "> [!NOTE]" blockquotes into alert boxes.
export function githubAlerts(md: MarkdownIt) {
  md.core.ruler.after('inline', 'github_alerts', (state: StateCore) => {
    const tokens = state.tokens
    for (let i = 0; i + 2 < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open' || tokens[i + 1].type !== 'paragraph_open') continue
      const inline = tokens[i + 2]
      const m = /^\[!(\w+)\]\s*/.exec(inline.content)
      if (!m || !alertTypes.includes(m[1].toLowerCase())) continue
      const kind = m[1].toLowerCase()
      tokens[i].tag = 'div'
      tokens[i].attrJoin('class', `alert alert-${kind}`)
      let depth = 0
      for (let j = i; j < tokens.length; j++) {
        if (tokens[j].type === 'blockquote_open') depth++
        if (tokens[j].type === 'blockquote_close' && --depth === 0) {
          tokens[j].tag = 'div'
          break
        }
      }
      inline.content = inline.content.slice(m[0].length)
      const first = inline.children?.[0]
      if (first && first.type === 'text') {
        first.content = first.content.replace(/^\[!\w+\]\s*/, '')
        if (first.content === '' && inline.children![1]?.type === 'softbreak') inline.children!.splice(0, 2)
      }
      const title = new state.Token('html_inline', '', 0)
      title.content = `<span class="alert-title">${kind[0].toUpperCase() + kind.slice(1)}</span>`
      inline.children?.unshift(title)
    }
  })
}

// imageSize reads HedgeDoc's ![alt](src =WxH) syntax.
export function imageSize(md: MarkdownIt) {
  const re = /^!\[([^\]]*)\]\(\s*(\S+?)\s+=(\d*%?)x(\d*%?)\s*(?:"([^"]*)")?\s*\)/
  md.inline.ruler.before('image', 'image_size', (state: StateInline, silent: boolean) => {
    if (state.src.charCodeAt(state.pos) !== 0x21) return false
    const m = re.exec(state.src.slice(state.pos))
    if (!m) return false
    const href = state.md.normalizeLink(m[2])
    if (!state.md.validateLink(href)) return false
    if (!silent) {
      const token = state.push('image', 'img', 0) as Token
      token.attrs = [['src', href], ['alt', '']]
      if (m[3]) token.attrs.push(['width', m[3]])
      if (m[4]) token.attrs.push(['height', m[4]])
      if (m[5]) token.attrs.push(['title', m[5]])
      const children: Token[] = []
      state.md.inline.parse(m[1], state.md, state.env, children)
      token.children = children
      token.content = m[1]
    }
    state.pos += m[0].length
    return true
  })
}

export function parseCSV(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === delimiter) {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (c !== '\r') cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}
