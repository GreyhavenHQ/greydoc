import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

// MenuPanel is a popup for the editor. Its items never take the focus, so the cursor stays in the text or the cell
// and the keys typed after a choice go there. A click outside or Escape closes it.
export function MenuPanel({
  top,
  left,
  right,
  label,
  role = 'menu',
  keep,
  onClose,
  className,
  testId,
  children,
}: {
  top: number
  left?: number
  right?: number
  label: string
  role?: 'menu' | 'dialog'
  // keep is the button that opened the panel. It toggles the panel itself.
  keep?: RefObject<HTMLElement | null>
  onClose: () => void
  className?: string
  testId?: string
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (!panel.current?.contains(t) && !keep?.current?.contains(t)) close.current()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close.current()
    }
    document.addEventListener('mousedown', down, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [keep])
  return createPortal(
    <div
      ref={panel}
      role={role}
      aria-label={label}
      style={{ top, left, right }}
      data-testid={testId}
      className={cn('fixed z-50 max-h-[70vh] overflow-y-auto rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md', className)}
    >
      {children}
    </div>,
    document.body,
  )
}

export function MenuItem({
  onSelect,
  disabled,
  pressed,
  label,
  className,
  children,
}: {
  onSelect: () => void
  disabled?: boolean
  pressed?: boolean
  label?: string
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4 [&_svg]:text-muted-foreground',
        pressed && 'text-primary',
        className,
      )}
    >
      {children}
    </button>
  )
}

export const MenuSeparator = () => <div className="-mx-1 my-1 h-px bg-border" />
