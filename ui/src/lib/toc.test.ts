import { describe, expect, it } from 'vitest'
import { activePath, buildTree } from '@/lib/toc'

const h = (id: string, level: number) => ({ id, text: id, level })

describe('table of contents tree', () => {
  const tree = buildTree([h('a', 1), h('a1', 2), h('a1x', 3), h('a2', 2), h('b', 1), h('b1', 2)])
  it('nests headings under the nearest higher level', () => {
    expect(tree.map((n) => n.id)).toEqual(['a', 'b'])
    expect(tree[0].children.map((n) => n.id)).toEqual(['a1', 'a2'])
    expect(tree[0].children[0].children.map((n) => n.id)).toEqual(['a1x'])
  })
  it('marks the active heading and its parents', () => {
    expect([...activePath(tree, 'a1x')].sort()).toEqual(['a', 'a1', 'a1x'])
    expect([...activePath(tree, 'b')]).toEqual(['b'])
    expect(activePath(tree, 'nope').size).toBe(0)
  })
  it('starts a new root when a document skips the first level', () => {
    expect(buildTree([h('x', 2), h('y', 3), h('z', 2)]).map((n) => n.id)).toEqual(['x', 'z'])
  })
})
