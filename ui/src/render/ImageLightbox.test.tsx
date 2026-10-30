import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ImageLightbox } from './ImageLightbox'

let root: Root | null = null

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.setPointerCapture = () => {}
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

function open() {
  const onClose = vi.fn()
  const host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  act(() => root!.render(<ImageLightbox src="/uploads/a.png" previewSrc="/uploads/a.png?w=1600" alt="Screen" onClose={onClose} />))
  const view = document.querySelector<HTMLElement>('[data-testid=lightbox-view]')!
  return { onClose, view }
}

function press(target: Element, down: [number, number], up: [number, number]) {
  act(() => {
    target.dispatchEvent(new PointerEvent('pointerdown', { clientX: down[0], clientY: down[1], bubbles: true }))
    target.dispatchEvent(new PointerEvent('pointerup', { clientX: up[0], clientY: up[1], bubbles: true }))
  })
}

describe('ImageLightbox', () => {
  it('shows the image, a close button and a link to the original', () => {
    open()
    const img = document.querySelector<HTMLImageElement>('[data-testid=lightbox-view] img')!
    expect(img.getAttribute('src')).toBe('/uploads/a.png?w=1600')
    expect(img.alt).toBe('Screen')
    const link = document.querySelector<HTMLAnchorElement>('a[aria-label="Open original"]')!
    expect(link.getAttribute('href')).toBe('/uploads/a.png')
    expect(link.target).toBe('_blank')
    expect(document.querySelector('button[aria-label="Close"]')).not.toBeNull()
  })

  it('closes on Escape', () => {
    const { onClose } = open()
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on a click on the background', () => {
    const { onClose, view } = open()
    press(view, [10, 10], [12, 11])
    expect(onClose).toHaveBeenCalled()
  })

  it('stays open after a drag on the background', () => {
    const { onClose, view } = open()
    press(view, [10, 10], [60, 10])
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stays open after a click on the image', () => {
    const { onClose, view } = open()
    press(view.querySelector('img')!, [10, 10], [10, 10])
    expect(onClose).not.toHaveBeenCalled()
  })
})
