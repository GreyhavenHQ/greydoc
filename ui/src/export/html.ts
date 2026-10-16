import markdownCss from '@/render/markdown.css?inline'
import katexCss from 'katex/dist/katex.min.css?inline'

// Light Greyhaven tokens, so an exported file looks the same without the app stylesheet.
const tokens = `:root{--background:240 240 236;--foreground:22 22 20;--card:249 249 247;--muted:240 240 236;
--muted-foreground:87 87 83;--border:196 196 189;--primary:217 94 42;--destructive:180 50 50;--radius:0.375rem;
--font-sans:Aspekta,ui-sans-serif,system-ui,sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
body{margin:0;background:rgb(var(--background));color:rgb(var(--foreground));font-family:var(--font-sans)}
main{max-width:52rem;margin:0 auto;padding:3rem 1.5rem}
.mermaid-block svg{max-width:100%;height:auto}`

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

// standaloneHTML returns a self-contained page: no scripts, styles inline, diagrams as inline SVG.
export function standaloneHTML(title: string, article: HTMLElement): string {
  const clone = article.cloneNode(true) as HTMLElement
  clone.querySelectorAll('.mermaid-block').forEach((b) => {
    const svg = b.querySelector('svg')
    if (svg) b.replaceChildren(svg)
  })
  clone.querySelectorAll('[data-line], [data-line-end]').forEach((el) => {
    el.removeAttribute('data-line')
    el.removeAttribute('data-line-end')
  })
  clone.querySelectorAll('script').forEach((el) => el.remove())
  // KaTeX fonts are not bundled. Math falls back to system fonts offline.
  const css = tokens + '\n' + katexCss.replace(/url\([^)]*\)/g, 'local("none")') + '\n' + markdownCss
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${css}</style></head>
<body><main><article class="markdown-body">${clone.innerHTML}</article></main></body></html>
`
}

export function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function fileName(title: string, ext: string) {
  const base = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  return (base || 'document') + ext
}
