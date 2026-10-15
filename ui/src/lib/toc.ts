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
