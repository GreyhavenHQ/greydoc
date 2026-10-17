import { api, ApiError } from '@/lib/api'
import { headingsOf, type Heading } from '@/render/markdown'

export interface NoteInfo {
  title: string
  headings: Heading[]
}

type Info = NoteInfo | null | undefined
const cache = new Map<string, { at: number; info: Promise<Info> }>()

// noteInfo is the title and headings of a note, null if no note has the alias, undefined if the viewer cannot read it.
export function noteInfo(alias: string): Promise<Info> {
  const hit = cache.get(alias)
  if (hit && Date.now() - hit.at < 60_000) return hit.info
  const info = api
    .get<{ title: string; content?: string }>('/api/notes/' + encodeURIComponent(alias))
    .then((n) => ({ title: n.title || alias, headings: headingsOf(n.content ?? '') }))
    .catch((e) => (e instanceof ApiError && e.status === 404 ? null : undefined))
  cache.set(alias, { at: Date.now(), info })
  return info
}

// hydrateNoteLinks shows the current title of each linked note. A link to a missing note or heading gets marked.
export function hydrateNoteLinks(root: HTMLElement): Promise<void> {
  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('a.note-link[data-alias]'))
  return Promise.all(
    links.map(async (a) => {
      const info = await noteInfo(a.dataset.alias!)
      if (!a.isConnected) return
      if (info === null) {
        a.classList.add('note-link-missing')
        a.title = 'No document has this address yet'
        return
      }
      if (!info) return
      const section = a.dataset.section
      const heading = section ? info.headings.find((h) => h.id.toLowerCase() === section) : undefined
      if (section && !heading) {
        a.classList.add('note-link-missing')
        a.title = 'No heading with this name in the document'
      }
      if (a.dataset.label) return
      a.textContent = heading ? `${info.title} › ${heading.text}` : info.title
    }),
  ).then(() => undefined)
}
