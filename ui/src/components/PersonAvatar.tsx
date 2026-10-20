import { memo } from 'react'
import { initials, personColor, personSeed } from '@/lib/authors'
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
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full leading-none font-semibold text-white select-none', sizes[size], className)}
      style={{ backgroundColor: personColor(seed) }}
    >
      {initials(name)}
    </span>
  )
})
