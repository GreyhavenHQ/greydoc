import { useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ExternalLink, X } from 'lucide-react'
import { attachPanZoom, type PanZoom } from '@/render/mermaid'

interface ImageLightboxProps {
  // src is the original file. previewSrc is the copy already loaded in the page, shown until src loads.
  src: string
  previewSrc?: string
  alt: string
  onClose: () => void
}

const button = 'inline-flex size-9 items-center justify-center rounded-md bg-black/60 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-white'

// ImageLightbox shows one image over the page. Wheel zooms, drag pans, double-click switches between fitted and 100 %.
export function ImageLightbox({ src, previewSrc, alt, onClose }: ImageLightboxProps) {
  const [shown, setShown] = useState(previewSrc ?? src)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const view = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLDivElement | null>(null)
  const pz = useRef<PanZoom | null>(null)
  const natural = useRef({ w: 0, h: 0 })
  const down = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (shown === src) return
    const img = new Image()
    img.onload = () => setShown(src)
    img.src = src
    return () => {
      img.onload = null
    }
  }, [src, shown])

  const onLoad = (img: HTMLImageElement) => {
    if (!img.naturalWidth || !img.naturalHeight) return
    natural.current = { w: img.naturalWidth, h: img.naturalHeight }
    const fit = Math.min(1, (0.95 * window.innerWidth) / img.naturalWidth, (0.95 * window.innerHeight) / img.naturalHeight)
    setBox({ w: img.naturalWidth * fit, h: img.naturalHeight * fit })
  }

  const attach = () => {
    if (pz.current || !view.current || !canvas.current) return
    pz.current = attachPanZoom(view.current, canvas.current, { wheel: 'always', doubleClick: false, maxScale: 64 })
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content aria-describedby={undefined} className="fixed inset-0 z-50 bg-black/85 outline-none" style={{ pointerEvents: 'auto' }} data-testid="lightbox">
          <DialogPrimitive.Title className="sr-only">{alt || 'Image'}</DialogPrimitive.Title>
          <div
            ref={(el) => {
              view.current = el
              attach()
            }}
            data-testid="lightbox-view"
            className="absolute inset-0 flex cursor-grab touch-none items-center justify-center overflow-hidden select-none active:cursor-grabbing"
            onPointerDown={(e) => {
              down.current = e.target === e.currentTarget ? { x: e.clientX, y: e.clientY } : null
            }}
            onPointerUp={(e) => {
              const d = down.current
              down.current = null
              if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) onClose()
            }}
            onDoubleClick={(e) => {
              const p = pz.current
              if (!p || !box) return
              if (p.scale() === 1) p.zoomAt(e.clientX, e.clientY, natural.current.w / box.w)
              else p.reset()
            }}
          >
            <div
              ref={(el) => {
                canvas.current = el
                attach()
              }}
              style={{ transformOrigin: '0 0' }}
            >
              <img
                src={shown}
                alt={alt}
                draggable={false}
                onLoad={(e) => onLoad(e.currentTarget)}
                style={box ? { width: box.w, height: box.h, maxWidth: 'none' } : { maxWidth: '95vw', maxHeight: '95vh' }}
              />
            </div>
          </div>
          <div className="absolute top-3 right-3 flex gap-2" data-panzoom-ignore>
            <a href={src} target="_blank" rel="noopener" aria-label="Open original" title="Open original" className={button}>
              <ExternalLink className="size-4" />
            </a>
            <DialogPrimitive.Close aria-label="Close" title="Close (Esc)" className={button}>
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
