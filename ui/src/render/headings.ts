// findHeading finds the target of #hash in root. HedgeDoc ids keep capitals, so a heading with the same id in any case also matches.
export function findHeading(root: HTMLElement, hash: string): HTMLElement | null {
  let id = hash.replace(/^#/, '')
  if (!id) return null
  try {
    id = decodeURIComponent(id)
  } catch {
    // keep the raw text
  }
  const exact = root.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
  if (exact) return exact
  const lower = id.toLowerCase()
  return Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')).find((h) => h.id.toLowerCase() === lower) ?? null
}

// scrollToHash moves the element named by the address hash to the top. It returns false when nothing matches.
export function scrollToHash(root: HTMLElement, hash = window.location.hash): boolean {
  const el = findHeading(root, hash)
  el?.scrollIntoView({ block: 'start' })
  return Boolean(el)
}
