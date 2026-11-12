import { useEffect, useState } from 'react'
import { MenuPanel } from '@/components/MenuPanel'
import type { NoteHit } from '@/editor/noteLinks'
import { cn } from '@/lib/utils'

// DocPicker finds a document to link to, where the [[ list of the editor cannot open, as in a table cell.
export function DocPicker({
  rect,
  search,
  onPick,
  onClose,
}: {
  rect: DOMRect
  search: (q: string) => Promise<NoteHit[]>
  onPick: (n: NoteHit) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<NoteHit[]>([])
  const [active, setActive] = useState(0)
  useEffect(() => {
    let live = true
    const t = setTimeout(() => search(q).then((h) => live && (setHits(h.slice(0, 8)), setActive(0))), 120)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, search])
  return (
    <MenuPanel
      role="dialog"
      label="Link to a document"
      top={rect.bottom + 6}
      left={Math.max(8, Math.min(rect.left, window.innerWidth - 300))}
      onClose={onClose}
      testId="doc-picker"
      className="w-72"
    >
      <input
        autoFocus
        value={q}
        placeholder="Find a document"
        aria-label="Find a document"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, hits.length - 1))
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0))
          else if (e.key === 'Enter' && hits[active]) onPick(hits[active])
          else return
          e.preventDefault()
        }}
        className="mb-1 h-8 w-full rounded-sm border bg-background px-2 outline-none"
      />
      <div role="listbox" aria-label="Documents">
        {hits.map((n, i) => (
          <div
            key={n.alias}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(n)}
            className={cn('cursor-pointer truncate rounded-sm px-2 py-1.5', i === active && 'bg-accent text-accent-foreground')}
          >
            {n.title || n.alias} <span className="text-xs text-muted-foreground">{n.alias}</span>
          </div>
        ))}
        {!hits.length && <div className="px-2 py-1.5 text-muted-foreground">No document</div>}
      </div>
    </MenuPanel>
  )
}
