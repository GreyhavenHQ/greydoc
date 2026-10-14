import { describe, expect, it } from 'vitest'
import { attachPanZoom } from '@/render/mermaid'

describe('attachPanZoom', () => {
  it('keeps the point under the pointer in place', () => {
    const view = document.createElement('div')
    const canvas = document.createElement('div')
    view.appendChild(canvas)
    view.getBoundingClientRect = () => ({ left: 100, top: 50, right: 700, bottom: 450, width: 600, height: 400, x: 100, y: 50, toJSON: () => ({}) })
    Object.defineProperty(canvas, 'offsetLeft', { value: 16 })
    Object.defineProperty(canvas, 'offsetTop', { value: 16 })
    attachPanZoom(view, canvas)
    // The pointer is 200px right and 100px down from the canvas origin.
    view.dispatchEvent(new WheelEvent('wheel', { clientX: 316, clientY: 166, deltaY: -100, metaKey: true, cancelable: true }))
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(canvas.style.transform)!
    const [x, y, s] = [Number(m[1]), Number(m[2]), Number(m[3])]
    expect(s).toBeGreaterThan(1)
    expect(x + 200 * s).toBeCloseTo(200)
    expect(y + 100 * s).toBeCloseTo(100)
  })
})
