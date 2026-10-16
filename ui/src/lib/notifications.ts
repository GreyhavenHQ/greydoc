export interface Notification {
  id: string
  note_id: string
  note_alias: string
  note_title: string
  kind: 'document' | 'comment' | 'suggestion'
  actor_id: string
  actor_name: string
  ref?: string
  excerpt?: string
  created_at: string
  read_at?: string
}

export interface Inbox {
  list: Notification[]
  unread: number
}

export function notificationHref(n: Notification): string {
  const base = '/n/' + encodeURIComponent(n.note_alias)
  return n.kind === 'document' || !n.ref ? base + '?mention=1' : base + '?thread=' + encodeURIComponent(n.ref)
}

export function notificationText(n: Notification): string {
  const title = n.note_title || n.note_alias
  const where = n.kind === 'comment' ? 'in a comment on ' : n.kind === 'suggestion' ? 'in a suggestion on ' : 'in '
  return `${n.actor_name || 'Someone'} mentioned you ${where}${title}`
}

// markRead marks the given ids as read, or every notification when ids is null.
export function markRead(inbox: Inbox, ids: string[] | null, at: string): Inbox {
  let changed = 0
  const list = inbox.list.map((n) => {
    if (n.read_at || (ids && !ids.includes(n.id))) return n
    changed++
    return { ...n, read_at: at }
  })
  return { list, unread: ids ? Math.max(0, inbox.unread - changed) : 0 }
}
