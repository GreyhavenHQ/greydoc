import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { applyMention, displayNames, isSelf, mentionsOn, nextPicker, searchPeople, splitMentions, type Person, type PickerState } from '@/lib/mentions'
import { cn } from '@/lib/utils'

// offerAccess runs when someone picks a person who cannot open the document. Only a full-access writer can share.
export function offerAccess(alias: string, canShare: boolean) {
  return (p: Person) => {
    const name = p.display_name || p.username
    if (!canShare) {
      toast.warning(`${name} cannot open this document, so they will not be notified.`)
      return
    }
    toast(`${name} cannot open this document.`, {
      description: 'Without access they get no notification.',
      duration: 15000,
      action: {
        label: 'Give comment access',
        onClick: () =>
          api
            .put(`/api/notes/${alias}/permissions/users/${encodeURIComponent(p.username)}`, { level: 'comment' })
            .then(() => toast.success(`${name} can now comment`))
            .catch((e) => toast.error(e instanceof Error ? e.message : String(e))),
      },
    })
  }
}

type TextareaProps = Omit<React.ComponentProps<'textarea'>, 'value' | 'onChange'>

// MentionTextarea is a textarea with an @ picker. Esc or a click elsewhere closes the picker and keeps the text.
export function MentionTextarea({
  value,
  onValueChange,
  alias,
  onNoAccess,
  onKeyDown,
  onBlur,
  ...props
}: TextareaProps & { value: string; onValueChange: (v: string) => void; alias?: string; onNoAccess?: (p: Person) => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const caretAfterPick = useRef<number | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [people, setPeople] = useState<Person[]>([])
  const [active, setActive] = useState(0)
  const query = picker && !picker.dismissed ? picker.query : null

  useEffect(() => {
    if (query === null) return
    let live = true
    const t = setTimeout(() => {
      searchPeople(query, alias)
        .then((ps) => {
          if (!live) return
          setPeople(ps.slice(0, 8))
          setActive(0)
        })
        .catch(() => live && setPeople([]))
    }, 120)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query, alias])

  useLayoutEffect(() => {
    if (caretAfterPick.current === null || !ref.current) return
    ref.current.setSelectionRange(caretAfterPick.current, caretAfterPick.current)
    caretAfterPick.current = null
  }, [value])

  const track = (text: string, caret: number) => setPicker((p) => (mentionsOn() ? nextPicker(p, text, caret) : null))
  const open = query !== null && people.length > 0

  const pick = (p: Person) => {
    const el = ref.current
    if (!picker || !el) return
    const r = applyMention(value, picker.from, el.selectionStart, p)
    caretAfterPick.current = r.caret
    onValueChange(r.text)
    setPicker(null)
    if (p.can_read === false) onNoAccess?.(p)
  }

  return (
    <div className="relative">
      <Textarea
        {...props}
        ref={ref}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value)
          track(e.target.value, e.target.selectionStart)
        }}
        onSelect={(e) => track(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={(e) => {
          setPicker((p) => p && { ...p, dismissed: true })
          onBlur?.(e)
        }}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : people.length - 1)) % people.length)
              return
            }
            if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
              e.preventDefault()
              pick(people[active])
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setPicker((p) => p && { ...p, dismissed: true })
              return
            }
          }
          onKeyDown?.(e)
        }}
      />
      {open && (
        <ul role="listbox" className="absolute top-full left-0 z-50 mt-1 w-64 rounded-md border bg-popover p-1 text-sm shadow-md" data-testid="mention-picker">
          {people.map((p, i) => (
            <li
              key={p.username}
              role="option"
              aria-selected={i === active}
              className={cn('flex cursor-pointer items-baseline gap-2 rounded px-2 py-1', i === active && 'bg-accent')}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(p)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="truncate font-medium">{p.display_name || p.username}</span>
              <span className="truncate text-xs text-muted-foreground">@{p.username}</span>
              {p.can_read === false && <span className="ml-auto shrink-0 text-xs text-amber-600">no access</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// MentionText shows text with mentions as chips, with the current names when signed in.
export function MentionText({ text }: { text: string }) {
  const parts = useMemo(() => splitMentions(text), [text])
  const users = parts.flatMap((p) => (typeof p === 'string' ? [] : [p.username])).join(' ')
  const [names, setNames] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    if (!users || !mentionsOn()) return
    let live = true
    void displayNames(users.split(' ')).then((n) => live && setNames(n))
    return () => {
      live = false
    }
  }, [users])
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <span key={i} className={cn('mention', isSelf(p.username) && 'mention-self')} data-user={p.username}>
            @{names.get(p.username) ?? p.label}
          </span>
        ),
      )}
    </>
  )
}
