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
    void hydrateNoteLinks(el)
    void hydrateMermaid(el, { mode: resolvedTheme }).then(() => onRendered?.(el))
    onRendered?.(el)
  }, [source, resolvedTheme, onRendered])

  // Task boxes follow whether toggling is allowed, which can change without the text changing.
  const canToggle = Boolean(onToggleTask)
  useLayoutEffect(() => {
    root.current?.querySelectorAll<HTMLInputElement>('li[data-line] > input[type=checkbox], li[data-line] > label > input[type=checkbox]').forEach((b) => {
      b.disabled = !canToggle
      b.classList.toggle('task-toggle', canToggle)
    })
  }, [canToggle, source, resolvedTheme])

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
