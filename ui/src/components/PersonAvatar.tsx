import { memo } from 'react'
import Avatar from 'boring-avatars'
import { initials, palette, personSeed } from '@/lib/authors'
import { useMe } from '@/lib/me'
import { cn } from '@/lib/utils'

const sizes = {
  16: 'size-4 text-[7px]',
  20: 'size-5 text-[9px]',
  24: 'size-6 text-[10px]',
  28: 'size-7 text-[11px]',
  32: 'size-8 text-xs',
}

export const PersonAvatar = memo(function PersonAvatar({
  id,
  name,
  size = 24,
  title,
  className,
}: {
  id?: string
  name: string
  size?: keyof typeof sizes
  title?: string
  className?: string
}) {
  const { me } = useMe()
  const seed = personSeed(id, name, !!me?.local_mode)
  return (
    <span
      data-testid="person-avatar"
      title={title ?? name}
      className={cn('relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', sizes[size], className)}
    >
      <Avatar variant="marble" name={seed} colors={palette} className="absolute inset-0 size-full" aria-hidden />
      <span className="relative leading-none [text-shadow:0_0_2px_rgb(0_0_0/0.7)]">{initials(name)}</span>
    </span>
  )
})
