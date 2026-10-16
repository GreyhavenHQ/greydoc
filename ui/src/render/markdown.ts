import MarkdownItCallable, { type MarkdownIt, type RendererRule } from 'markdown-it'
import DOMPurify from 'dompurify'
import anchor from 'markdown-it-anchor'
import taskLists from 'markdown-it-task-lists'
import { full as emoji } from 'markdown-it-emoji'
import footnote from 'markdown-it-footnote'
import container from 'markdown-it-container'
import mark from 'markdown-it-mark'
import sub from 'markdown-it-sub'
import sup from 'markdown-it-sup'
import deflist from 'markdown-it-deflist'
import abbr from 'markdown-it-abbr'
import ins from 'markdown-it-ins'
import katex from '@vscode/markdown-it-katex'
import hljs from 'highlight.js/lib/common'
import { githubAlerts, imageSize, mentions, noteLinks, parseCSV, slugify, sourceLines, toc } from '@/render/plugins'
import { splitFrontMatter, type FrontMatter } from '@/lib/meta'

let lineOffset = 0

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function highlight(code: string, lang: string): string {
  const name = lang.replace(/=$/, '').trim()
  if (name && hljs.getLanguage(name)) {
    try {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value
    } catch {
      // fall through to plain text
    }
  }
  return escapeHtml(code)
}

const md: MarkdownIt = new MarkdownItCallable({ html: true, linkify: true, typographer: false, breaks: true, highlight })

// The icon is drawn by CSS. An empty link keeps heading text clean for the TOC and comment anchors.
md.use(anchor, {
  slugify,
  tabIndex: false,
  permalink: anchor.permalink.linkInsideHeader({
    symbol: '',
    space: false,
    placement: 'before',
    renderAttrs: () => ({ 'aria-label': 'Link to this section' }),
  }),
})
md.use(taskLists, { enabled: false, label: true })
md.use(emoji)
md.use(footnote)
md.use(mark)
md.use(sub)
md.use(sup)
md.use(deflist)
md.use(abbr)
md.use(ins)
// @vscode/markdown-it-katex types itself against @types/markdown-it 14, not markdown-it 15.
md.use(katex as unknown as (md: MarkdownIt, opts: { throwOnError: boolean }) => void, { throwOnError: false })
md.use(imageSize)
md.use(noteLinks)
md.use(mentions)
md.use(githubAlerts)
md.use(toc)
sourceLines(md, () => lineOffset)

for (const kind of ['success', 'info', 'warning', 'danger']) {
  md.use(container, kind, {
    render: (tokens: { nesting: number; info: string }[], idx: number) =>
      tokens[idx].nesting === 1 ? `<div class="alert alert-${kind}">\n` : '</div>\n',
  })
}
md.use(container, 'spoiler', {
  validate: (params: string) => /^spoiler(\s+.*)?$/.test(params.trim()),
  render: (tokens: { nesting: number; info: string }[], idx: number) => {
    if (tokens[idx].nesting !== 1) return '</details>\n'
    const title = tokens[idx].info.trim().replace(/^spoiler\s*/, '') || 'Spoiler'
    return `<details class="spoiler"><summary>${md.utils.escapeHtml(title)}</summary>\n`
  },
})

// KaTeX renders block math without the token's attributes.
const defaultMath = md.renderer.rules.math_block!
md.renderer.rules.math_block = (tokens, idx, options, env, self) =>
  defaultMath(tokens, idx, options, env, self).replace(/^<p class="katex-block[^"]*"/, (m) => m + self.renderAttrs(tokens[idx]))

const defaultFence = md.renderer.rules.fence!
const fence: RendererRule = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const info = token.info.trim()
  const lang = info.split(/\s+/)[0]
  const lines = `data-line="${token.attrGet('data-line') ?? ''}" data-line-end="${token.attrGet('data-line-end') ?? ''}"`
  if (lang === 'mermaid') {
    return `<div class="mermaid-block" ${lines}><pre class="mermaid-source">${escapeHtml(token.content)}</pre></div>\n`
  }
  if (lang === 'csvpreview') {
    const header = /header="?true"?/.test(info)
    const delim = /delimiter="(.)"/.exec(info)?.[1] ?? ','
    const rows = parseCSV(token.content.trimEnd(), delim)
    const cells = (r: string[], tag: string) => '<tr>' + r.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join('') + '</tr>'
    const head = header && rows.length ? `<thead>${cells(rows[0], 'th')}</thead>` : ''
    const body = (header ? rows.slice(1) : rows).map((r) => cells(r, 'td')).join('')
    return `<table class="csv-table" ${lines}>${head}<tbody>${body}</tbody></table>\n`
  }
  if (lang) {
    token.info = lang.replace(/=$/, '')
    const out = defaultFence(tokens, idx, options, env, self)
    return out.replace(/class="language-/, 'class="hljs language-')
  }
  return defaultFence(tokens, idx, options, env, self)
}
md.renderer.rules.fence = fence

const purifyConfig = {
  ADD_TAGS: ['details', 'summary'],
  ADD_ATTR: ['target', 'open'],
  FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'button', 'iframe', 'object', 'embed'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
}

// Task list checkboxes are inputs. Allow those and nothing else of the form family.
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'input') {
    const el = node as Element
    if (el.getAttribute('type') !== 'checkbox') el.parentNode?.removeChild(el)
  }
})

// Large local uploads come from a resized copy. The server returns the original when it is already small.
// eagerImages is set while a deck renders. Its hidden slides must have their images ready.
let eagerImages = false

const resizable = /^\/uploads\/[0-9a-f]{32}\.(?:png|jpg)$/

// Base CSS sets img height to auto, which beats the width and height attributes. Inline styles keep them.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'IMG') return
  const el = node as HTMLImageElement
  for (const dim of ['width', 'height'] as const) {
    const m = /^\s*(\d+(?:\.\d+)?)(px|%)?\s*$/.exec(el.getAttribute(dim) ?? '')
    if (m) el.style[dim] = m[1] + (m[2] ?? 'px')
  }
  if (eagerImages) el.setAttribute('loading', 'eager')
  else if (!el.hasAttribute('loading')) el.setAttribute('loading', 'lazy')
  el.setAttribute('decoding', 'async')
  const src = el.getAttribute('src') ?? ''
  if (resizable.test(src)) el.setAttribute('src', src + '?w=1600')
})

export interface Rendered {
  html: string
  frontMatter: FrontMatter | null
}

export function renderMarkdown(src: string, opts: { eagerImages?: boolean } = {}): Rendered {
  const { data, body, bodyLine } = splitFrontMatter(src)
  lineOffset = bodyLine
  const raw = md.render(body)
  lineOffset = 0
  eagerImages = Boolean(opts.eagerImages)
  try {
    const html = DOMPurify.sanitize(raw, {
      ...purifyConfig,
      FORBID_TAGS: purifyConfig.FORBID_TAGS.filter((t) => t !== 'input'),
    }) as string
    return { html, frontMatter: data }
  } finally {
    eagerImages = false
  }
}

export interface Heading {
  level: number
  text: string
  id: string
}

// headingsOf lists the headings of a note with the ids the renderer gives them.
export function headingsOf(src: string): Heading[] {
  const tokens = md.parse(splitFrontMatter(src).body, {})
  const out: Heading[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type !== 'heading_open') continue
    const text = (tokens[i + 1].children ?? []).map((c) => c.content).join('').trim()
    out.push({ level: Number(t.tag.slice(1)), text, id: String(t.attrGet('id') ?? '') })
  }
  return out
}

export function renderInline(src: string): string {
  return DOMPurify.sanitize(md.renderInline(src), purifyConfig) as string
}
