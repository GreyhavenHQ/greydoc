import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Preview } from '@/render/Preview'
import { useNote } from '@/lib/useNote'
import { extractTitle } from '@/lib/meta'
import { loginHref } from '@/lib/me'
import { download, fileName, standaloneHTML } from '@/export/html'
import { hydrateMermaid } from '@/render/mermaid'
import { renderMarkdown } from '@/render/markdown'
import { Spinner } from '@/components/ui/spinner'
import { api } from '@/lib/api'
import { WithToc } from '@/components/TocSidebar'
import { takeBoot } from '@/lib/boot'

// View is the read-only page for clients: the rendered note and nothing else.
export default function View({ alias: given }: { alias?: string } = {}) {
  const params = useParams()
  const alias = given ?? params.alias ?? ''
  const { note, text, error } = useNote(alias)
  const title = extractTitle(text) || note?.title || 'Untitled'
  const exported = useRef(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    document.title = title
  }, [title])

  useEffect(() => {
    const wantsExport = new URLSearchParams(location.search).get('export') === 'html'
    if (!wantsExport || !note || exported.current) return
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
  }, [note, text, title])

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
    <main data-testid="view-page">
      <WithToc show>
        <div className="px-6 py-12">
          {exporting && <div className="mb-4 text-sm text-muted-foreground">Preparing the HTML file…</div>}
          <Preview source={text} />
        </div>
      </WithToc>
    </main>
  )
}

// ShortShare opens a view-only link of the form /v/<token>. The token alone names the note.
export function ShortShare() {
  const { token = '' } = useParams()
  const [first] = useState(() => {
    const b = takeBoot('share')
    return b && b.token === token ? b.alias : undefined
  })
  const [alias, setAlias] = useState<string | null | undefined>(first)
  useEffect(() => {
    if (first) return
    api
      .get<{ alias: string }>('/api/share/' + encodeURIComponent(token))
      .then((r) => setAlias(r.alias))
      .catch(() => setAlias(null))
  }, [token, first])
  if (alias === null) return <div className="flex h-screen items-center justify-center text-muted-foreground">This link does not exist or was revoked.</div>
  if (!alias) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    )
  }
  return <View alias={alias} />
}
