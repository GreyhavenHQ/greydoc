export interface Heading {
  id: string
  text: string
  level: number
}

export interface TocNode extends Heading {
  children: TocNode[]
}

// buildTree nests headings under the nearest heading of a higher level.
export function buildTree(headings: Heading[]): TocNode[] {
  const roots: TocNode[] = []
  const stack: TocNode[] = []
  for (const h of headings) {
    const node: TocNode = { ...h, children: [] }
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop()
    if (stack.length) stack[stack.length - 1].children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

// activePath is the active heading and every heading above it.
export function activePath(nodes: TocNode[], active: string): Set<string> {
  for (const n of nodes) {
    if (n.id === active) return new Set([n.id])
    const below = activePath(n.children, active)
    if (below.size) return below.add(n.id)
  }
  return new Set()
}

// activeHeading is the last heading above the reading line, or the last heading at the end of the document.
export function activeHeading(tops: { id: string; top: number }[], line: number, atEnd: boolean): string {
  if (!tops.length) return ''
  if (atEnd) return tops[tops.length - 1].id
  let current = tops[0].id
  for (const t of tops) if (t.top <= line) current = t.id
  return current
}
