import { forwardRef, useEffect, useLayoutEffect, useRef } from 'react'
import 'katex/dist/katex.min.css'
import { renderMarkdown } from '@/render/markdown'
import { hydrateMermaid } from '@/render/mermaid'
import { useTheme } from '@/lib/theme'

interface PreviewProps {
  source: string
  className?: string
  onRendered?: (root: HTMLElement) => void
}

export const Preview = forwardRef<HTMLElement, PreviewProps>(function Preview({ source, className, onRendered }, ref) {
  const root = useRef<HTMLElement | null>(null)
  const { resolvedTheme } = useTheme()

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    el.innerHTML = renderMarkdown(source).html
    void hydrateMermaid(el, { mode: resolvedTheme }).then(() => onRendered?.(el))
    onRendered?.(el)
  }, [source, resolvedTheme, onRendered])

  useEffect(() => {
    const el = root.current
    if (!el) return
    // Rendered task list checkboxes are display only.
    const stop = (e: Event) => {
      if ((e.target as HTMLElement).matches('input[type=checkbox]')) e.preventDefault()
    }
    el.addEventListener('click', stop)
    return () => el.removeEventListener('click', stop)
  }, [])

  return (
    <article
      ref={(el) => {
        root.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) ref.current = el
      }}
      className={'markdown-body ' + (className ?? '')}
      data-testid="preview"
    />
  )
})

// scrollToSourceLine scrolls container so the block rendered from line is at the top.
export function scrollToSourceLine(container: HTMLElement, article: HTMLElement, line: number, fraction = 0) {
  const blocks = Array.from(article.querySelectorAll<HTMLElement>('[data-line]'))
  if (!blocks.length) return
  let before = blocks[0]
  let after: HTMLElement | null = null
  for (const b of blocks) {
    const l = Number(b.dataset.line)
    if (l <= line) before = b
    else {
      after = b
      break
    }
  }
  const top = (el: HTMLElement) => el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
  const l0 = Number(before.dataset.line)
  let y = top(before)
  if (after) {
    const l1 = Number(after.dataset.line)
    const t = l1 > l0 ? (line + fraction - l0) / (l1 - l0) : 0
    y += (top(after) - y) * Math.min(Math.max(t, 0), 1)
  }
  container.scrollTo({ top: Math.max(0, y - 16) })
}
