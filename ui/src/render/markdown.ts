import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: true })

export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(md.render(src))
}
