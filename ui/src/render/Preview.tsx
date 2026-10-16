import { forwardRef, useEffect, useLayoutEffect, useRef } from 'react'
import 'katex/dist/katex.min.css'
import { renderMarkdown } from '@/render/markdown'
import { hydrateMermaid } from '@/render/mermaid'
import { hydrateNoteLinks } from '@/render/noteLinks'
import { findHeading, scrollToHash } from '@/render/headings'
import { toast } from 'sonner'
import { hydrateMentions } from '@/render/mentions'
import { useTheme } from '@/lib/theme'

interface PreviewProps {
  source: string
  className?: string
  onRendered?: (root: HTMLElement) => void
  // onToggleTask makes task boxes clickable. It gets the box's zero-based source line.
  onToggleTask?: (line: number) => void
  // followHash moves to the heading named in the address after a render, until the user scrolls.
  followHash?: boolean
}

export const Preview = forwardRef<HTMLElement, PreviewProps>(function Preview({ source, className, onRendered, onToggleTask, followHash }, ref) {
  const root = useRef<HTMLElement | null>(null)
  const pendingHash = useRef(Boolean(followHash && window.location.hash))
  const toggle = useRef(onToggleTask)
  toggle.current = onToggleTask
  const { resolvedTheme } = useTheme()

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    el.innerHTML = renderMarkdown(source).html
    const toHash = () => {
      if (pendingHash.current && el.isConnected) scrollToHash(el)
    }
    void hydrateNoteLinks(el)
    void hydrateMentions(el)
    void hydrateMermaid(el, { mode: resolvedTheme }).then(() => {
      onRendered?.(el)
      toHash()
    })
    onRendered?.(el)
    toHash()
  }, [source, resolvedTheme, onRendered])

  // Late content such as diagrams moves the heading, so the hash wins until the user acts or 10 s pass.
  useEffect(() => {
    if (!followHash) return
    const stop = () => {
      pendingHash.current = false
    }
    const onHash = () => {
      if (root.current) scrollToHash(root.current)
    }
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const
    events.forEach((t) => window.addEventListener(t, stop, { passive: true, capture: true }))
    window.addEventListener('hashchange', onHash)
    const timer = window.setTimeout(stop, 10_000)
    return () => {
      window.clearTimeout(timer)
      events.forEach((t) => window.removeEventListener(t, stop, { capture: true }))
      window.removeEventListener('hashchange', onHash)
    }
  }, [followHash])

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
    // Links inside the page set the hash without a navigation, so the router keeps its state.
    const jump = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]')
      if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const target = findHeading(el, a.getAttribute('href')!)
      if (!target) return
      e.preventDefault()
      const url = new URL(window.location.href)
      url.hash = target.id
      window.history.replaceState(window.history.state, '', url)
      target.scrollIntoView({ block: 'start' })
      if (a.classList.contains('header-anchor')) {
        navigator.clipboard?.writeText(url.href).then(() => toast.success('Link copied'), () => {})
      }
    }
    el.addEventListener('click', stop)
    el.addEventListener('click', jump)
    return () => {
      el.removeEventListener('click', stop)
      el.removeEventListener('click', jump)
    }
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
