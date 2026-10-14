import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Preview } from '@/render/Preview'
import { useLiveNote } from '@/lib/useLiveNote'
import { extractTitle } from '@/lib/meta'
import { loginHref } from '@/lib/me'
import { download, fileName, standaloneHTML } from '@/export/html'
import { hydrateMermaid } from '@/render/mermaid'
import { renderMarkdown } from '@/render/markdown'
import { Spinner } from '@/components/ui/spinner'

// View is the read-only page for clients: the rendered note and nothing else.
export default function View() {
  const { alias = '' } = useParams()
  const { note, text, error, synced } = useLiveNote(alias)
  const title = extractTitle(text) || note?.title || 'Untitled'
  const exported = useRef(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    document.title = title
  }, [title])

  useEffect(() => {
    const wantsExport = new URLSearchParams(location.search).get('export') === 'html'
    if (!wantsExport || !note || !synced || exported.current) return
    exported.current = true
    setExporting(true)
    const box = document.createElement('article')
    box.className = 'markdown-body'
    box.style.cssText = 'position:absolute;left:-10000px;top:0;width:800px'
    document.body.appendChild(box)
    box.innerHTML = renderMarkdown(text).html
    hydrateMermaid(box, { interactive: false, mode: 'light' })
      .then(() => download(fileName(title, '.html'), standaloneHTML(title, box), 'text/html'))
      .finally(() => {
        box.remove()
        setExporting(false)
      })
  }, [note, synced, text, title])

  if (error) {
    if (error.status === 401) {
      location.href = loginHref()
      return null
    }
    return <div className="flex h-screen items-center justify-center text-muted-foreground">{error.status === 404 ? 'This note does not exist.' : error.message}</div>
  }
  if (!note) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    )
  }
  return (
    <main className="mx-auto max-w-3xl px-6 py-12" data-testid="view-page">
      {exporting && <div className="mb-4 text-sm text-muted-foreground">Preparing the HTML file…</div>}
      <Preview source={text} />
    </main>
  )
}
