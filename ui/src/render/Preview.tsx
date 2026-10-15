import { forwardRef, useEffect, useLayoutEffect, useRef } from 'react'
import 'katex/dist/katex.min.css'
import { renderMarkdown } from '@/render/markdown'
import { hydrateMermaid } from '@/render/mermaid'
import { hydrateNoteLinks } from '@/render/noteLinks'
import { useTheme } from '@/lib/theme'

interface PreviewProps {
  source: string
  className?: string
  onRendered?: (root: HTMLElement) => void
  // onToggleTask makes task boxes clickable. It gets the box's zero-based source line.
  onToggleTask?: (line: number) => void
}

export const Preview = forwardRef<HTMLElement, PreviewProps>(function Preview({ source, className, onRendered, onToggleTask }, ref) {
  const root = useRef<HTMLElement | null>(null)
  const toggle = useRef(onToggleTask)
  toggle.current = onToggleTask
  const { resolvedTheme } = useTheme()

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    el.innerHTML = renderMarkdown(source).html
    if (toggle.current) {
      el.querySelectorAll<HTMLInputElement>('li[data-line] > input[type=checkbox], li[data-line] > label > input[type=checkbox]').forEach((b) => {
        b.disabled = false
        b.classList.add('task-toggle')
      })
    }
    void hydrateNoteLinks(el)
    void hydrateMermaid(el, { mode: resolvedTheme }).then(() => onRendered?.(el))
    onRendered?.(el)
  }, [source, resolvedTheme, onRendered])

  useEffect(() => {
    const el = root.current
    if (!el) return
    // A task box changes the source, not the rendered page: the new text renders the new state.
    const stop = (e: Event) => {
      const box = e.target as HTMLElement
      if (!box.matches('input[type=checkbox]')) return
      e.preventDefault()
      const line = box.closest('li[data-line]')?.getAttribute('data-line')
      if (toggle.current && line != null) toggle.current(Number(line))
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
