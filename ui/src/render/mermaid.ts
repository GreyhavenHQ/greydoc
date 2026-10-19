import type { Mermaid } from 'mermaid'
import { diagramUsesElk, mermaidConfig } from '@/render/mermaidTheme'

type Mode = 'light' | 'dark'

let loader: Promise<Mermaid> | null = null
let initialized = ''

const cache = new Map<string, string>()
let counter = 0

// load fetches Mermaid once. A failed fetch is forgotten so the next diagram tries again.
function load(): Promise<Mermaid> {
  loader ??= (async () => {
    const m = (await import('mermaid')).default
    const elk = (await import('@mermaid-js/layout-elk')).default
    m.registerLayoutLoaders(elk)
    return m
  })().catch((e) => {
    loader = null
    throw e
  })
  return loader
}

export function themeMode(): Mode {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

type Pending = { job: Promise<string>; stale: (() => boolean)[] | null }
const inflight = new Map<string, Pending>()
// Mermaid keeps global state while rendering, so renders run one at a time.
let queue: Promise<unknown> = Promise.resolve()

// renderMermaid returns SVG markup or an error box, cached per theme and source. It returns '' when every caller is stale.
export function renderMermaid(src: string, mode: Mode = themeMode(), stale?: () => boolean): Promise<string> {
  const key = mode + '\n' + src
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(key)
  if (pending) {
    if (!stale) pending.stale = null
    else pending.stale?.push(stale)
    return pending.job
  }
  const entry: Pending = { job: Promise.resolve(''), stale: stale ? [stale] : null }
  const job = queue.then(async () => {
    if (entry.stale?.every((s) => s())) {
      inflight.delete(key)
      return ''
    }
    const id = 'mermaid-' + ++counter
    let out: string
    try {
      const m = await load()
      const elk = diagramUsesElk(src)
      if (initialized !== mode + elk) {
        m.initialize(mermaidConfig(mode, elk))
        initialized = mode + elk
      }
      const { svg } = await m.render(id, src)
      out = svg
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)
      out = `<div class="mermaid-error"><strong>Diagram error</strong><pre>${msg}</pre></div>`
    } finally {
      document.getElementById('d' + id)?.remove()
    }
    inflight.delete(key)
    if (!loader) return out
    if (cache.size > 200) cache.delete(cache.keys().next().value!)
    cache.set(key, out)
    return out
  })
  queue = job.catch(() => undefined)
  entry.job = job
  inflight.set(key, entry)
  return job
}

function cached(src: string, mode: Mode): string | undefined {
  return cache.get(mode + '\n' + src)
}

const icons = {
  plus: '+',
  minus: '−',
  full: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
  reset: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  svg: 'SVG',
  png: 'PNG',
}

export interface PanZoom {
  reset: () => void
  zoomBy: (factor: number) => void
}

// attachPanZoom zooms the canvas around the pointer (Ctrl or Cmd + wheel, or pinch) and pans on drag.
export function attachPanZoom(view: HTMLElement, canvas: HTMLElement): PanZoom {
  let scale = 1
  let x = 0
  let y = 0
  const apply = () => {
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    view.classList.toggle('is-zoomed', scale !== 1 || x !== 0 || y !== 0)
  }
  // zoomAt keeps the canvas point under (px, py) in place. px and py are relative to the canvas layout box.
  const zoomAt = (px: number, py: number, factor: number) => {
    const next = Math.min(8, Math.max(0.2, scale * factor))
    x = px - ((px - x) * next) / scale
    y = py - ((py - y) * next) / scale
    scale = next
    apply()
  }
  const origin = () => {
    const rect = view.getBoundingClientRect()
    return { left: rect.left + view.clientLeft + canvas.offsetLeft, top: rect.top + view.clientTop + canvas.offsetTop }
  }
  view.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) && !view.classList.contains('is-fullscreen')) return
      e.preventDefault()
      const o = origin()
      zoomAt(e.clientX - o.left, e.clientY - o.top, Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002)))
    },
    { passive: false },
  )
  let drag: { x: number; y: number } | null = null
  view.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('.mermaid-toolbar')) return
    drag = { x: e.clientX - x, y: e.clientY - y }
    view.setPointerCapture(e.pointerId)
  })
  view.addEventListener('pointermove', (e) => {
    if (!drag) return
    x = e.clientX - drag.x
    y = e.clientY - drag.y
    apply()
  })
  view.addEventListener('pointerup', () => (drag = null))
  const reset = () => {
    scale = 1
    x = 0
    y = 0
    apply()
  }
  view.addEventListener('dblclick', reset)
  return {
    reset,
    zoomBy: (factor) => zoomAt(canvas.offsetWidth / 2, canvas.offsetHeight / 2, factor),
  }
}

async function svgToPng(svg: SVGSVGElement): Promise<Blob> {
  const box = svg.viewBox.baseVal
  const w = Math.ceil(box?.width || svg.getBoundingClientRect().width)
  const h = Math.ceil(box?.height || svg.getBoundingClientRect().height)
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    await new Promise((res, rej) => {
      img.onload = res
      img.onerror = rej
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = w * 2
    canvas.height = h * 2
    const ctx = canvas.getContext('2d')!
    ctx.scale(2, 2)
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    return await new Promise((res) => canvas.toBlob((b) => res(b!), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

function mount(block: HTMLElement, svgMarkup: string, interactive: boolean, natural = false) {
  block.dataset.rendered = svgMarkup.length.toString()
  if (!interactive || svgMarkup.startsWith('<div class="mermaid-error"')) {
    block.innerHTML = svgMarkup
    if (natural) naturalSize(block)
    return
  }
  block.innerHTML = `<div class="mermaid-view"><div class="mermaid-canvas">${svgMarkup}</div><div class="mermaid-toolbar">
    <button type="button" data-act="minus" title="Zoom out">${icons.minus}</button>
    <button type="button" data-act="plus" title="Zoom in (or Ctrl + wheel over the diagram)">${icons.plus}</button>
    <button type="button" data-act="reset" title="Reset zoom">${icons.reset}</button>
    <button type="button" data-act="svg" title="Copy SVG">${icons.svg}</button>
    <button type="button" data-act="png" title="Copy PNG">${icons.png}</button>
    <button type="button" data-act="full" title="Full screen">${icons.full}</button></div></div>`
  const view = block.querySelector<HTMLElement>('.mermaid-view')!
  const canvas = block.querySelector<HTMLElement>('.mermaid-canvas')!
  const pz = attachPanZoom(view, canvas)
  view.addEventListener('fullscreenchange', () => {
    view.classList.toggle('is-fullscreen', document.fullscreenElement === view)
    pz.reset()
  })
  block.querySelector('.mermaid-toolbar')!.addEventListener('click', async (e) => {
    const act = (e.target as Element).closest('button')?.dataset.act
    const svg = canvas.querySelector('svg') as SVGSVGElement | null
    if (!act || !svg) return
    if (act === 'reset') pz.reset()
    if (act === 'plus') pz.zoomBy(1.25)
    if (act === 'minus') pz.zoomBy(0.8)
    if (act === 'full') {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await view.requestFullscreen()
    }
    if (act === 'svg') await navigator.clipboard.writeText(new XMLSerializer().serializeToString(svg))
    if (act === 'png') await navigator.clipboard.write([new ClipboardItem({ 'image/png': svgToPng(svg) })])
  })
}

// naturalSize shows diagrams at their own size. Wide ones scroll instead of shrinking to unreadable text.
export function naturalSize(host: HTMLElement) {
  host.querySelectorAll('svg').forEach((svg) => {
    const w = (svg as SVGSVGElement).viewBox?.baseVal?.width
    if (!w || svg.closest('.mermaid-view')) return
    svg.style.maxWidth = 'none'
    svg.style.width = Math.round(w) + 'px'
    svg.style.height = 'auto'
  })
  host.style.overflowX = 'auto'
}

// hydrateMermaid replaces mermaid placeholders under root with diagrams.
export function hydrateMermaid(root: HTMLElement, opts: { interactive?: boolean; mode?: Mode; natural?: boolean } = {}): Promise<void> {
  const mode = opts.mode ?? themeMode()
  const interactive = opts.interactive ?? true
  const jobs: Promise<void>[] = []
  root.querySelectorAll<HTMLElement>('.mermaid-block').forEach((block) => {
    const src = block.querySelector('.mermaid-source')?.textContent ?? block.dataset.source ?? ''
    block.dataset.source = src
    const hit = cached(src, mode)
    if (hit) {
      mount(block, hit, interactive, opts.natural)
      return
    }
    jobs.push(
      renderMermaid(src, mode, () => !block.isConnected || block.dataset.source !== src).then((svg) => {
        if (svg && block.isConnected && block.dataset.source === src) mount(block, svg, interactive, opts.natural)
      }),
    )
  })
  return Promise.all(jobs).then(() => undefined)
}
