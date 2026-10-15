import { useEffect, useState } from 'react'
import { Copy, Link2, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { api, type AgentPolicy, type Level, type User } from '@/lib/api'
import { useMe } from '@/lib/me'

interface Permissions {
  owner: User | null
  users: { user_id: string; username: string; display_name: string; level: Level }[]
  groups: { group: string; level: Level }[]
  share_links: { id: string; token: string; label: string; created_at: string }[] | null
  agent_policy: AgentPolicy
  guest_max: Level
}

const levelLabels: Record<string, string> = {
  deny: 'No access',
  read: 'Can view',
  comment: 'Can comment',
  write: 'Can edit',
}

const policyLabels: Record<AgentPolicy, string> = {
  none: 'No agent access',
  read: 'Agents can read',
  suggest: 'Agents suggest changes',
  edit: 'Agents can edit directly',
}

function LevelSelect({ value, onChange, max, disabled }: { value: Level; onChange: (l: Level) => void; max?: Level; disabled?: boolean }) {
  const order: Level[] = ['deny', 'read', 'comment', 'write']
  const allowed = max ? order.slice(0, order.indexOf(max) + 1) : order
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Level)} disabled={disabled}>
      <SelectTrigger className="h-8 w-36 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowed.map((l) => (
          <SelectItem key={l} value={l} className="text-xs">
            {levelLabels[l]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ShareDialog({ alias, isOwner, open, onOpenChange }: { alias: string; isOwner: boolean; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { me } = useMe()
  const [perm, setPerm] = useState<Permissions | null>(null)
  const [userQuery, setUserQuery] = useState('')
  const [found, setFound] = useState<{ users: User[]; groups: string[] }>({ users: [], groups: [] })
  const base = '/api/notes/' + alias

  useEffect(() => {
    if (open) api.get<Permissions>(base + '/permissions').then(setPerm)
  }, [open, base])

  useEffect(() => {
    if (!open || !isOwner || me?.local_mode) return
    const t = setTimeout(() => {
      api.get<{ users: User[]; groups: string[] }>('/api/users?q=' + encodeURIComponent(userQuery)).then(setFound)
    }, 200)
    return () => clearTimeout(t)
  }, [userQuery, open, isOwner, me])

  const call = async (fn: () => Promise<Permissions>) => {
    try {
      setPerm(await fn())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const setGroup = (group: string, level: Level) =>
    call(() => (level === 'deny' ? api.del<Permissions>(`${base}/permissions/groups/${encodeURIComponent(group)}`) : api.put<Permissions>(`${base}/permissions/groups/${encodeURIComponent(group)}`, { level })))
  const setUser = (username: string, level: Level) =>
    call(() => (level === 'deny' ? api.del<Permissions>(`${base}/permissions/users/${encodeURIComponent(username)}`) : api.put<Permissions>(`${base}/permissions/users/${encodeURIComponent(username)}`, { level })))

  const groupLevel = (g: string) => perm?.groups.find((x) => x.group === g)?.level ?? 'deny'
  const namedGroups = perm?.groups.filter((g) => !g.group.startsWith('_')) ?? []

  const createLink = async () => {
    const r = await api.post<{ url: string }>(base + '/share-links', { label: 'view-only' })
    await navigator.clipboard?.writeText(r.url).catch(() => {})
    toast.success('View-only link copied')
    setPerm(await api.get<Permissions>(base + '/permissions'))
  }

  const linkURL = (token: string) => `${location.origin}/v/${token}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share and protect</DialogTitle>
          <DialogDescription>
            {me?.local_mode ? 'Local mode: everyone who can reach this server can edit.' : 'Choose who can view, comment on and edit this document.'}
          </DialogDescription>
        </DialogHeader>
        {!perm ? null : (
          <div className="flex flex-col gap-5 text-sm">
            {!me?.local_mode && (
              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span>Owner</span>
                  <span className="text-muted-foreground">{perm.owner?.display_name || perm.owner?.username || 'nobody'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Signed-in users</span>
                  <LevelSelect value={groupLevel('_signed_in')} onChange={(l) => setGroup('_signed_in', l)} disabled={!isOwner} />
                </div>
                <div className="flex items-center justify-between">
                  <span>
                    Anyone with the address <span className="text-muted-foreground">(no sign-in)</span>
                  </span>
                  <LevelSelect value={groupLevel('_everyone')} onChange={(l) => setGroup('_everyone', l)} max={perm.guest_max} disabled={!isOwner} />
                </div>
                {namedGroups.map((g) => (
                  <div key={g.group} className="flex items-center justify-between">
                    <span>
                      Group <span className="font-mono text-xs">{g.group}</span>
                    </span>
                    <LevelSelect value={g.level} onChange={(l) => setGroup(g.group, l)} disabled={!isOwner} />
                  </div>
                ))}
                {perm.users.map((u) => (
                  <div key={u.user_id} className="flex items-center justify-between">
                    <span>
                      {u.display_name || u.username} <span className="text-muted-foreground">@{u.username}</span>
                    </span>
                    <LevelSelect value={u.level} onChange={(l) => setUser(u.username, l)} disabled={!isOwner} />
                  </div>
                ))}
                {isOwner && (
                  <div className="flex flex-col gap-1.5 pt-1">
                    <Label htmlFor="share-user" className="text-xs text-muted-foreground">
                      Add a person or group
                    </Label>
                    <Input id="share-user" value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder="Name or group" className="h-8" />
                    {userQuery && (
                      <div className="flex flex-col rounded-md border">
                        {found.users.map((u) => (
                          <button key={u.id} className="flex items-center gap-2 px-2 py-1.5 text-left hover:bg-muted" onClick={() => { setUser(u.username, 'write'); setUserQuery('') }}>
                            <UserPlus className="size-3.5" /> {u.display_name || u.username} <span className="text-muted-foreground">@{u.username}</span>
                          </button>
                        ))}
                        {found.groups
                          .filter((g) => g.toLowerCase().includes(userQuery.toLowerCase()))
                          .map((g) => (
                            <button key={g} className="flex items-center gap-2 px-2 py-1.5 text-left hover:bg-muted" onClick={() => { setGroup(g, 'write'); setUserQuery('') }}>
                              <UserPlus className="size-3.5" /> Group <span className="font-mono text-xs">{g}</span>
                            </button>
                          ))}
                        {found.users.length === 0 && !found.groups.some((g) => g.toLowerCase().includes(userQuery.toLowerCase())) && (
                          <button className="px-2 py-1.5 text-left hover:bg-muted" onClick={() => { setGroup(userQuery.trim(), 'write'); setUserQuery('') }}>
                            Grant group “{userQuery.trim()}”
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>
            )}

            {isOwner && (
              <>
                <Separator />
                <section className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <div>View-only links</div>
                      <div className="text-xs text-muted-foreground">For clients: rendered document only, no editor or comments.</div>
                    </div>
                    <Button size="sm" variant="outline" onClick={createLink}>
                      <Link2 className="size-4" /> New link
                    </Button>
                  </div>
                  {perm.share_links?.map((l) => (
                    <div key={l.id} className="flex items-center gap-2">
                      <Input readOnly value={linkURL(l.token)} className="h-8 font-mono text-xs" onFocus={(e) => e.target.select()} />
                      <Button size="icon" variant="ghost" aria-label="Copy link" onClick={() => navigator.clipboard?.writeText(linkURL(l.token)).then(() => toast.success('Copied'))}>
                        <Copy className="size-4" />
                      </Button>
                      <Button size="icon" variant="ghost" aria-label="Revoke link" onClick={() => call(() => api.del<Permissions>(`${base}/share-links/${l.id}`))}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                </section>
                <Separator />
                <section className="flex items-center justify-between gap-4">
                  <div>
                    <div>AI agents (MCP)</div>
                    <div className="text-xs text-muted-foreground">What an agent acting for a user may do here.</div>
                  </div>
                  <Select value={perm.agent_policy} onValueChange={(v) => call(() => api.put<Permissions>(base + '/agent-policy', { policy: v }))}>
                    <SelectTrigger className="h-8 w-52 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(policyLabels) as AgentPolicy[]).map((p) => (
                        <SelectItem key={p} value={p} className="text-xs">
                          {policyLabels[p]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </section>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
