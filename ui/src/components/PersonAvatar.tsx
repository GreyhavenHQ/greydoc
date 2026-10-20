import { memo } from 'react'
import Avatar from 'boring-avatars'
import { initials, palette } from '@/lib/authors'
import { cn } from '@/lib/utils'

const sizes = {
  16: 'size-4 text-[7px]',
  20: 'size-5 text-[9px]',
  24: 'size-6 text-[10px]',
  32: 'size-8 text-xs',
}

export const PersonAvatar = memo(function PersonAvatar({
  seed,
  name,
  size = 24,
  className,
}: {
  seed: string
  name: string
  size?: keyof typeof sizes
  className?: string
}) {
  return (
    <span
      data-testid="person-avatar"
      title={name}
      className={cn('relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', sizes[size], className)}
    >
      <Avatar variant="marble" name={seed} colors={palette} className="absolute inset-0 size-full" aria-hidden />
      <span className="relative leading-none [text-shadow:0_0_2px_rgb(0_0_0/0.7)]">{initials(name)}</span>
    </span>
  )
})
