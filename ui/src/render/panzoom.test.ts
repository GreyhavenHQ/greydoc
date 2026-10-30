import { describe, expect, it } from 'vitest'
import { attachPanZoom, type PanZoomOptions } from '@/render/mermaid'

function setup(opts?: PanZoomOptions) {
  const view = document.createElement('div')
  const canvas = document.createElement('div')
  view.appendChild(canvas)
  view.getBoundingClientRect = () => ({ left: 100, top: 50, right: 700, bottom: 450, width: 600, height: 400, x: 100, y: 50, toJSON: () => ({}) })
  view.setPointerCapture = () => {}
  Object.defineProperty(canvas, 'offsetLeft', { value: 16 })
  Object.defineProperty(canvas, 'offsetTop', { value: 16 })
  const pz = attachPanZoom(view, canvas, opts)
  const transform = () => {
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec(canvas.style.transform)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1]
  }
  return { view, canvas, pz, transform }
}

describe('attachPanZoom', () => {
  it('keeps the point under the pointer in place', () => {
    const { view, transform } = setup()
    // The pointer is 200px right and 100px down from the canvas origin.
    view.dispatchEvent(new WheelEvent('wheel', { clientX: 316, clientY: 166, deltaY: -100, metaKey: true, cancelable: true }))
    const [x, y, s] = transform()
    expect(s).toBeGreaterThan(1)
    expect(x + 200 * s).toBeCloseTo(200)
    expect(y + 100 * s).toBeCloseTo(100)
  })

  it('ignores a plain wheel by default', () => {
    const { view, transform } = setup()
    view.dispatchEvent(new WheelEvent('wheel', { clientX: 316, clientY: 166, deltaY: -100, cancelable: true }))
    expect(transform()[2]).toBe(1)
  })

  it('zooms on a plain wheel with wheel always', () => {
    const { view, transform } = setup({ wheel: 'always' })
    view.dispatchEvent(new WheelEvent('wheel', { clientX: 316, clientY: 166, deltaY: -100, cancelable: true }))
    expect(transform()[2]).toBeGreaterThan(1)
  })

  it('zooms around a client point with zoomAt', () => {
    const { pz, transform } = setup({ maxScale: 20 })
    pz.zoomAt(316, 166, 10)
    const [x, y, s] = transform()
    expect(s).toBe(10)
    expect(pz.scale()).toBe(10)
    expect(x + 200 * s).toBeCloseTo(200)
    expect(y + 100 * s).toBeCloseTo(100)
  })

  it('resets on double-click unless disabled', () => {
    const a = setup()
    a.pz.zoomBy(2)
    a.view.dispatchEvent(new MouseEvent('dblclick'))
    expect(a.pz.scale()).toBe(1)
    const b = setup({ doubleClick: false })
    b.pz.zoomBy(2)
    b.view.dispatchEvent(new MouseEvent('dblclick'))
    expect(b.pz.scale()).toBe(2)
  })

  it('does not drag from an element marked data-panzoom-ignore', () => {
    const { view, canvas, transform } = setup()
    const button = document.createElement('button')
    button.setAttribute('data-panzoom-ignore', '')
    canvas.appendChild(button)
    button.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true }))
    view.dispatchEvent(new PointerEvent('pointermove', { clientX: 60, clientY: 60 }))
    expect(transform()[0]).toBe(0)
  })
})
