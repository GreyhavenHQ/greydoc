import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { useMe } from '@/lib/me'
import { markRead, notificationHref, notificationText, type Inbox, type Notification } from '@/lib/notifications'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

// NotificationBell lists mentions of the signed-in user. It refreshes every minute and when the tab gets focus.
export function NotificationBell() {
  const { me } = useMe()
  const on = Boolean(me?.authenticated && !me.local_mode)
  const [inbox, setInbox] = useState<Inbox>({ list: [], unread: 0 })
  const [open, setOpen] = useState(false)

  const load = useCallback(() => {
    api
      .get<{ notifications: Notification[]; unread: number }>('/api/notifications')
      .then((r) => setInbox({ list: r.notifications, unread: r.unread }))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!on) return
    load()
    const t = setInterval(load, 60_000)
    const onFocus = () => document.visibilityState === 'visible' && load()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [on, load])

  if (!on) return null

  const read = (ids: string[] | null) => {
    setInbox((s) => markRead(s, ids, new Date().toISOString()))
    void api.post('/api/notifications/read', ids ? { ids } : { all: true }).catch(load)
  }

  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o && load())}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications, ${inbox.unread} unread`} data-testid="notification-bell">
          <Bell className="size-4" />
          {inbox.unread > 0 && (
            <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular-nums" data-testid="notification-count">
              {inbox.unread > 99 ? '99+' : inbox.unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center border-b px-3 py-2 text-sm font-medium">
          Notifications
          <div className="flex-1" />
          {inbox.unread > 0 && (
            <button className="text-xs font-normal text-muted-foreground hover:text-foreground" onClick={() => read(null)}>
              Mark all as read
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {inbox.list.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">No mentions yet.</p>}
          {inbox.list.map((n) => (
            <Link
              key={n.id}
              to={notificationHref(n)}
              reloadDocument
              className={cn('block border-b px-3 py-2 text-sm last:border-b-0 hover:bg-accent', !n.read_at && 'bg-primary/5')}
              onClick={() => {
                if (!n.read_at) read([n.id])
                setOpen(false)
              }}
              data-testid="notification"
            >
              <div className="flex items-start gap-2">
                {!n.read_at && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate">{notificationText(n)}</div>
                  {n.excerpt && <div className="line-clamp-2 text-xs text-muted-foreground">{n.excerpt}</div>}
                  <div className="text-[11px] text-muted-foreground">{relativeTime(n.created_at)}</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
