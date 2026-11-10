import { useEffect, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { linkAt, linkChange } from '@/editor/format'

export interface LinkTarget {
  text: string
  url: string
  existing: boolean
  // top and left are relative to the editor.
  top: number
  left: number
}

// linkTarget reads the link at the cursor, or the selection that becomes a link.
export function linkTarget(view: EditorView): LinkTarget {
  const link = linkAt(view.state)
  const sel = view.state.selection.main
  const from = link?.from ?? sel.from
  const to = link?.to ?? sel.to
  const host = view.dom.getBoundingClientRect()
  const start = view.coordsAtPos(from)
  const end = view.coordsAtPos(to, -1) ?? start
  return {
    text: link?.text ?? view.state.sliceDoc(sel.from, sel.to),
    url: link?.url ?? '',
    existing: !!link,
    top: end ? end.bottom - host.top + 6 : 40,
    left: start ? Math.max(4, Math.min(start.left - host.left, host.width - 330)) : 40,
  }
}

// LinkPopover edits the text and the address of a link, so nobody needs to see its Markdown.
export function LinkPopover({ view, target, onClose }: { view: EditorView; target: LinkTarget; onClose: () => void }) {
  const [text, setText] = useState(target.text)
  const [url, setUrl] = useState(target.url)
  const address = useRef<HTMLInputElement>(null)
  useEffect(() => address.current?.focus(), [])
  const done = (apply?: string) => {
    if (apply !== undefined && (apply || target.existing)) view.dispatch(linkChange(view.state, text, apply))
    onClose()
    view.focus()
  }
  return (
    <div
      className="absolute z-30 w-80 space-y-2 rounded-md border bg-popover p-3 text-sm shadow-md"
      style={{ top: target.top, left: target.left }}
      data-testid="link-popover"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          done()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          done(url.trim())
        }
      }}
    >
      <div className="grid gap-1">
        <Label htmlFor="link-text">Text</Label>
        <Input id="link-text" value={text} onChange={(e) => setText(e.target.value)} className="h-8" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="link-url">Address</Label>
        <Input id="link-url" ref={address} value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} className="h-8" />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        {target.existing && (
          <Button variant="ghost" size="sm" className="mr-auto" onClick={() => done('')}>
            Remove link
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => done()}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => done(url.trim())}>
          Save
        </Button>
      </div>
    </div>
  )
}
