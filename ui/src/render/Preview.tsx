import { useMemo } from 'react'
import { renderMarkdown } from '@/render/markdown'

export function Preview({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source])
  return <article className="markdown-body" data-testid="preview" dangerouslySetInnerHTML={{ __html: html }} />
}
