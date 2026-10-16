import { describe, expect, it } from 'vitest'
import { buildPoints, lineForY, measure, yForLine } from '@/render/scrollSync'

describe('scroll map', () => {
  const points = buildPoints(
    [
      { line: 0, y: 0 },
      { line: 1, y: 40 },
      { line: 2, y: 60 },
      { line: 10, y: 860 },
      { line: 12, y: 900 },
    ],
    20,
    1000,
  )

  it('interpolates between anchors', () => {
    expect(yForLine(points, 0.5)).toBe(20)
    expect(yForLine(points, 6)).toBe(460)
    expect(yForLine(points, 11)).toBe(880)
  })
  it('inverts the map', () => {
    for (const line of [0.25, 1.5, 3, 9.75, 11, 16]) expect(lineForY(points, yForLine(points, line))).toBeCloseTo(line)
  })
  it('maps the last line to the bottom of the pane', () => {
    expect(yForLine(points, 20)).toBe(1000)
    expect(yForLine(points, 16)).toBe(950)
    expect(lineForY(points, 1000)).toBe(20)
  })
  it('drops points that go backwards, such as footnotes rendered at the end', () => {
    const p = buildPoints(
      [
        { line: 2, y: 100 },
        { line: 3, y: 900 },
        { line: 4, y: 200 },
        { line: 6, y: 300 },
      ],
      10,
      1000,
    )
    expect(p.map((x) => x.line)).toEqual([0, 2, 4, 6, 10])
  })
  it('clamps points below the last scroll position', () => {
    const p = buildPoints([{ line: 5, y: 1200 }], 10, 1000)
    expect(p).toEqual([
      { line: 0, y: 0 },
      { line: 5, y: 1000 },
      { line: 10, y: 1000 },
    ])
  })
  it('puts a line shared by an end and a start at the start of the next block', () => {
    const p = buildPoints(
      [
        { line: 0, y: 0 },
        { line: 1, y: 30 },
        { line: 1, y: 50 },
        { line: 2, y: 80 },
      ],
      2,
      80,
    )
    expect(yForLine(p, 1)).toBe(50)
    expect(yForLine(p, 0.5)).toBe(15)
    expect(lineForY(p, 40)).toBe(1)
  })
})

describe('measure', () => {
  it('skips anchors that are not rendered', () => {
    const pane = document.createElement('section')
    pane.innerHTML = '<article><p data-line="0" data-line-end="1">a</p><details><p data-line="3" data-line-end="4">b</p></details></article>'
    document.body.appendChild(pane)
    const rects = new Map([['a', { top: 10, bottom: 30 }]])
    for (const p of pane.querySelectorAll('p')) {
      const r = rects.get(p.textContent!)
      p.getClientRects = () => (r ? [r] : []) as unknown as DOMRectList
      p.getBoundingClientRect = () => (r ?? { top: 0, bottom: 0 }) as DOMRect
    }
    pane.querySelector('article')!.getBoundingClientRect = () => ({ top: 10 }) as DOMRect
    expect(measure(pane, pane.querySelector('article')!, 5).map((p) => p.line)).toEqual([0, 1, 5])
  })
})
