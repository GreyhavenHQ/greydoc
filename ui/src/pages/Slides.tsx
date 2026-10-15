import { useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import Reveal from 'reveal.js'
import RevealNotes from 'reveal.js/plugin/notes'
import 'reveal.js/reveal.css'
import 'reveal.js/theme/white.css'
import 'katex/dist/katex.min.css'
import { useLiveNote } from '@/lib/useLiveNote'
import { splitSlides } from '@/render/slides'
import { renderMarkdown } from '@/render/markdown'
import { hydrateMermaid } from '@/render/mermaid'
import { splitFrontMatter, extractTitle } from '@/lib/meta'
import { Spinner } from '@/components/ui/spinner'

// pick copies the reveal.js options that HedgeDoc's slideOptions also accepts.
function pick(opts: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => opts[k] !== undefined).map((k) => [k, opts[k]]))
}

function slideHTML(src: string) {
  return renderMarkdown(src).html
}

// Slides renders the note as a reveal.js deck, like HedgeDoc's slide mode.
export default function Slides() {
  const { alias = '' } = useParams()
  const { note, text, error } = useLiveNote(alias)
  const host = useRef<HTMLDivElement>(null)
  const deck = useRef<InstanceType<typeof Reveal> | null>(null)

  useEffect(() => {
    document.title = (extractTitle(text) || note?.title || 'Slides') + ' · slides'
  }, [text, note])

  useEffect(() => {
    const el = host.current?.querySelector('.slides') as HTMLElement | null
    if (!el || !note) return
    const slides = splitSlides(text)
    el.innerHTML = slides
      .map((s) => {
        const one = (b: string, n: string) => `<section>${slideHTML(b)}${n.trim() ? `<aside class="notes">${slideHTML(n)}</aside>` : ''}</section>`
        return s.vertical.length ? `<section>${s.vertical.map((v) => one(v.body, v.notes)).join('')}</section>` : one(s.body, s.notes)
      })
      .join('')
    void hydrateMermaid(el, { interactive: false, mode: 'light' })
    const opts = (splitFrontMatter(text).data?.slideOptions ?? {}) as Record<string, unknown>
    if (!deck.current) {
      deck.current = new Reveal(host.current!, {
        hash: true,
        embedded: false,
        transition: (opts.transition as 'slide') ?? 'slide',
        slideNumber: Boolean(opts.slideNumber),
        ...pick(opts, ['width', 'height', 'margin', 'center', 'controls', 'progress', 'backgroundTransition']),
        plugins: [RevealNotes],
      })
      void deck.current.initialize()
    } else {
      deck.current.sync()
    }
  }, [text, note])

  useEffect(
    () => () => {
      try {
        deck.current?.destroy()
      } catch {
        // already torn down
      }
      deck.current = null
    },
    [],
  )

  if (error) return <div className="flex h-screen items-center justify-center text-muted-foreground">{error.message}</div>
  return (
    <div className="h-screen w-screen" data-testid="slides-page">
      {!note && (
        <div className="flex h-screen items-center justify-center">
          <Spinner />
        </div>
      )}
      <div className="reveal greydoc-deck" ref={host}>
        <div className="slides" />
      </div>
    </div>
  )
}
