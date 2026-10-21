import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { activePath, buildTree, type Heading, type TocNode as Node } from '@/lib/toc'
import { docWidthPx, type DocWidth } from '@/lib/meta'

function collect(root: HTMLElement): Heading[] {
  return Array.from(root.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id]')).map((h) => ({
    id: h.id,
    text: h.textContent ?? '',
    level: Number(h.tagName[1]),
  }))
}

// TocList shows the top level always. Sub-headings show under the section being read, or all with expandAll.
function TocList({ nodes, active, onPath, expandAll, go, depth = 0 }: {
  nodes: Node[]
  active: string
  onPath: Set<string>
  expandAll: boolean
  go: (id: string) => void
  depth?: number
}) {
  return (
    <ul className={depth === 0 ? 'space-y-0.5 border-l' : 'space-y-0.5'}>
      {nodes.map((n) => (
        <li key={n.id}>
          <a
            href={'#' + n.id}
            onClick={(e) => {
              e.preventDefault()
              go(n.id)
            }}
            aria-current={active === n.id ? 'location' : undefined}
            className={cn(
              '-ml-px block truncate border-l py-0.5 pr-2 hover:text-foreground',
              active === n.id ? 'border-primary font-medium text-foreground' : 'border-transparent',
              onPath.has(n.id) && active !== n.id ? 'text-foreground' : active !== n.id && 'text-muted-foreground',
            )}
            style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}
          >
            {n.text}
          </a>
          {n.children.length > 0 && (expandAll || onPath.has(n.id)) && (
            <TocList nodes={n.children} active={active} onPath={onPath} expandAll={expandAll} go={go} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  )
}

// WithToc centers its content and puts a table of contents in the right margin, like HedgeDoc's view mode.
// scroller is the scrolling element. Without it, the window scrolls. inset is the side padding of children, in px.
export function WithToc({ show, scroller, width = 'normal', inset, children }: {
  show: boolean
  scroller?: HTMLElement | null
  width?: DocWidth
  inset: number
  children: React.ReactNode
}) {
  const main = useRef<HTMLDivElement>(null)
  const [headings, setHeadings] = useState<Heading[]>([])
  const [active, setActive] = useState('')
  const [expandAll, setExpandAll] = useState(false)

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
  const scrollTo = (bottom: boolean) => {
    const target = scroller ?? document.documentElement
    ;(scroller ?? window).scrollTo({ top: bottom ? target.scrollHeight : 0, behavior: 'smooth' })
  }
  const tree = buildTree(headings)
  const onPath = activePath(tree, active)
  const visible = show && headings.length >= 2

  return (
    <div
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_minmax(0,var(--doc-column))_minmax(0,1fr)]',
        visible && width === 'wide' && 'xl:grid-cols-[minmax(0,1fr)_minmax(0,var(--doc-column))_minmax(15rem,1fr)]',
      )}
      style={{ '--doc-column': `${docWidthPx[width] + 2 * inset}px` } as React.CSSProperties}
      data-width={width}
    >
      <div />
      <div ref={main} className="min-w-0">
        {children}
      </div>
      <div className="min-w-0">
        {visible && (
          <nav className="sticky top-6 hidden max-h-[calc(100vh-6rem)] w-60 overflow-y-auto py-8 pl-8 text-sm xl:block" aria-label="Table of contents" data-testid="toc-sidebar">
            <div className="mb-2 text-xs font-medium text-muted-foreground">On this page</div>
            <TocList nodes={tree} active={active} onPath={onPath} expandAll={expandAll} go={go} />
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <button onClick={() => setExpandAll(!expandAll)} className="hover:text-foreground">
                {expandAll ? 'Collapse all' : 'Expand all'}
              </button>
              <button onClick={() => scrollTo(false)} className="flex items-center gap-0.5 hover:text-foreground">
                <ArrowUp className="size-3" /> Top
              </button>
              <button onClick={() => scrollTo(true)} className="flex items-center gap-0.5 hover:text-foreground">
                <ArrowDown className="size-3" /> Bottom
              </button>
            </div>
          </nav>
        )}
      </div>
    </div>
  )
}
