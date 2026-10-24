import { describe, expect, it } from 'vitest'
import { activeHeading, activePath, buildTree } from '@/lib/toc'

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

describe('active heading', () => {
  const tops = [{ id: 'a', top: -400 }, { id: 'b', top: 50 }, { id: 'c', top: 300 }, { id: 'd', top: 500 }]
  it('is the last heading above the line', () => {
    expect(activeHeading(tops, 80, false)).toBe('b')
  })
  it('is the first heading when none is above the line', () => {
    expect(activeHeading([{ id: 'a', top: 200 }, { id: 'b', top: 400 }], 80, false)).toBe('a')
  })
  it('is the last heading at the end of the document', () => {
    expect(activeHeading(tops, 80, true)).toBe('d')
  })
  it('is empty without headings', () => {
    expect(activeHeading([], 80, true)).toBe('')
  })
})
