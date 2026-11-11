import { renderInline } from '@/render/markdown'

// A grid cell in the document style is edited as rendered text. These functions write its HTML back to Markdown.

const marks: Record<string, string> = { STRONG: '**', B: '**', EM: '*', I: '*', S: '~~', DEL: '~~', STRIKE: '~~', MARK: '==' }

const escapeText = (s: string) =>
  s
    .replace(/[\\`*[\]]/g, '\\$&')
    .replace(/~~/g, '\\~\\~')
    .replace(/==/g, '\\=\\=')
    .replace(/(^|\W)_|_(?=\W|$)/g, (m) => m.replace('_', '\\_'))

function children(n: Node): string | null {
  let out = ''
  for (const c of n.childNodes) {
    const s = walk(c)
    if (s === null) return null
    out += s
  }
  return out
}

// wrap puts a mark around text and keeps outer spaces outside it, where Markdown needs them.
function wrap(m: string, inner: string): string {
  const t = inner.trim()
  if (!t) return inner
  const lead = inner.slice(0, inner.indexOf(t))
  return lead + m + t + m + inner.slice(lead.length + t.length)
}

function walk(n: Node): string | null {
  if (n.nodeType === Node.TEXT_NODE) return escapeText((n as Text).data.replace(/\u00a0/g, ' '))
  if (n.nodeType !== Node.ELEMENT_NODE) return ''
  const el = n as HTMLElement
  switch (el.tagName) {
    case 'BR':
      return el.nextSibling ? null : ''
    case 'CODE': {
      const t = el.textContent ?? ''
      return t.includes('`') ? null : t ? '`' + t + '`' : ''
    }
    case 'A': {
      const href = el.getAttribute('href') ?? ''
      const inner = children(el)
      if (inner === null || !href) return null
      return el.textContent === href ? href : `[${inner}](${href})`
    }
    case 'SPAN':
      return el.attributes.length ? null : children(el)
  }
  const m = marks[el.tagName]
  if (!m) return null
  const inner = children(el)
  return inner === null ? null : wrap(m, inner)
}

// cellMarkdown writes the content of a cell as Markdown, or gives null for content it cannot write.
export const cellMarkdown = (el: Node): string | null => children(el)

// richCell says whether a cell can be edited as rendered text: its Markdown comes back unchanged.
export function richCell(src: string): boolean {
  const el = document.createElement('div')
  el.innerHTML = renderInline(src)
  return cellMarkdown(el) === src
}
