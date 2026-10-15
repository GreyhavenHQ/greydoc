import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import Reveal from 'reveal.js'
import RevealNotes from 'reveal.js/plugin/notes'
import 'reveal.js/reveal.css'
import 'reveal.js/theme/white.css'
import 'katex/dist/katex.min.css'
import { useLiveNote } from '@/lib/useLiveNote'
import { deckTheme, splitSlides } from '@/render/slides'
import { renderMarkdown } from '@/render/markdown'
import { hydrateMermaid } from '@/render/mermaid'
import { splitFrontMatter, extractTitle } from '@/lib/meta'
import { Spinner } from '@/components/ui/spinner'
import { useTheme } from '@/lib/theme'

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
  const { resolvedTheme } = useTheme()
  const chosen = deckTheme((splitFrontMatter(text).data?.slideOptions as Record<string, unknown> | undefined)?.theme)
  const [toggled, setToggled] = useState(false)
  const base = chosen ?? resolvedTheme
  const dark = (base === 'dark') !== toggled

  const mode: 'light' | 'dark' = dark ? 'dark' : 'light'
  const modeRef = useRef(mode)

  useEffect(() => {
    modeRef.current = mode
    document.body.classList.toggle('greydoc-deck-dark', mode === 'dark')
    const el = host.current?.querySelector('.slides') as HTMLElement | null
    if (el) void hydrateMermaid(el, { interactive: false, mode })
    return () => document.body.classList.remove('greydoc-deck-dark')
  }, [mode])

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
    void hydrateMermaid(el, { interactive: false, mode: modeRef.current })
    const opts = (splitFrontMatter(text).data?.slideOptions ?? {}) as Record<string, unknown>
    if (!deck.current) {
      deck.current = new Reveal(host.current!, {
        hash: true,
        embedded: false,
        transition: (opts.transition as 'slide') ?? 'slide',
        slideNumber: Boolean(opts.slideNumber),
        ...pick(opts, ['width', 'height', 'margin', 'center', 'controls', 'progress', 'backgroundTransition']),
        plugins: [RevealNotes],
        // D switches between the light and the dark deck.
        keyboard: { 68: () => setToggled((t) => !t) },
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
