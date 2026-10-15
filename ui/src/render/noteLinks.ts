import { api, ApiError } from '@/lib/api'

type Title = string | null | undefined
const cache = new Map<string, { at: number; title: Promise<Title> }>()

// noteTitle is the title of a note, null if no note has the alias, undefined if the viewer cannot read it.
function noteTitle(alias: string): Promise<Title> {
  const hit = cache.get(alias)
  if (hit && Date.now() - hit.at < 60_000) return hit.title
  const title = api
    .get<{ title: string }>('/api/notes/' + encodeURIComponent(alias))
    .then((n) => n.title || alias)
    .catch((e) => (e instanceof ApiError && e.status === 404 ? null : undefined))
  cache.set(alias, { at: Date.now(), title })
  return title
}

// hydrateNoteLinks shows the current title of each linked note. A link to a missing note gets marked.
export function hydrateNoteLinks(root: HTMLElement): Promise<void> {
  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('a.note-link[data-alias]'))
  return Promise.all(
    links.map(async (a) => {
      const title = await noteTitle(a.dataset.alias!)
      if (!a.isConnected) return
      if (title === null) {
        a.classList.add('note-link-missing')
        a.title = 'No note has this address yet'
      } else if (title && !a.dataset.label) {
        a.textContent = title
      }
    }),
  ).then(() => undefined)
}
