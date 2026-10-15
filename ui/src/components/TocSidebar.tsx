import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Heading {
  id: string
  text: string
  level: number
}

function collect(root: HTMLElement): Heading[] {
  return Array.from(root.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id]')).map((h) => ({
    id: h.id,
    text: h.textContent ?? '',
    level: Number(h.tagName[1]),
  }))
}

// WithToc centers its content and puts a table of contents in the right margin, like HedgeDoc's view mode.
// scroller is the scrolling element. Without it, the window scrolls.
export function WithToc({ show, scroller, children }: { show: boolean; scroller?: HTMLElement | null; children: React.ReactNode }) {
  const main = useRef<HTMLDivElement>(null)
  const [headings, setHeadings] = useState<Heading[]>([])
  const [active, setActive] = useState('')

  useEffect(() => {
    const el = main.current
    if (!show || !el) return
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setHeadings(collect(el)))
    }
    update()
    const mo = new MutationObserver(update)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      mo.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [show])

  const spy = useCallback(() => {
    const el = main.current
    if (!el || !headings.length) return
    const top = (scroller?.getBoundingClientRect().top ?? 0) + 80
    let current = headings[0].id
    for (const h of headings) {
      const node = el.querySelector(`[id="${CSS.escape(h.id)}"]`)
      if (node && node.getBoundingClientRect().top <= top) current = h.id
    }
    setActive(current)
  }, [headings, scroller])

  useEffect(() => {
    if (!show) return
    const target: HTMLElement | Window = scroller ?? window
    spy()
    target.addEventListener('scroll', spy, { passive: true })
    return () => target.removeEventListener('scroll', spy)
  }, [show, scroller, spy])

  const go = (id: string) => {
    main.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    history.replaceState(null, '', '#' + id)
  }
  const toTop = () => (scroller ?? window).scrollTo({ top: 0, behavior: 'smooth' })
  const min = Math.min(...headings.map((h) => h.level))
  const visible = show && headings.length >= 2

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,48rem)_minmax(0,1fr)]">
      <div />
      <div ref={main} className="min-w-0">
        {children}
      </div>
      <div className="min-w-0">
        {visible && (
          <nav className="sticky top-6 hidden max-h-[calc(100vh-6rem)] w-60 overflow-y-auto py-8 pl-8 text-sm xl:block" aria-label="Table of contents" data-testid="toc-sidebar">
            <div className="mb-2 text-xs font-medium text-muted-foreground">On this page</div>
            <ul className="space-y-1 border-l">
              {headings.map((h) => (
                <li key={h.id}>
                  <a
                    href={'#' + h.id}
                    onClick={(e) => {
                      e.preventDefault()
                      go(h.id)
                    }}
                    aria-current={active === h.id ? 'location' : undefined}
                    className={cn(
                      '-ml-px block truncate border-l py-0.5 pr-2 text-muted-foreground hover:text-foreground',
                      active === h.id ? 'border-primary font-medium text-foreground' : 'border-transparent',
                    )}
                    style={{ paddingLeft: `${0.75 + (h.level - min) * 0.75}rem` }}
                  >
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
            <button onClick={toTop} className="mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowUp className="size-3" /> Back to top
            </button>
          </nav>
        )}
      </div>
    </div>
  )
}
