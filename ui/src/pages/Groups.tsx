import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, FileText, Plus, Trash2, UserMinus, UserPlus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { AppHeader } from '@/components/AppHeader'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, type Group, type GroupNote, type User } from '@/lib/api'
import { loginHref, useMe } from '@/lib/me'
import { cn, handle } from '@/lib/utils'

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

type Detail = { group: Group; members: User[]; notes: GroupNote[] }

const levelLabels: Record<string, string> = { read: 'Can view', comment: 'Can comment', write: 'Can edit' }

function Initial({ user, className }: { user: User; className?: string }) {
  const name = user.display_name || user.username
  return (
    <span title={name} className={cn('flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold', className)}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function AvatarStack({ group }: { group: Group }) {
  const shown = group.members ?? []
  const more = group.member_count - shown.length
  if (shown.length === 0) return null
  return (
    <div className="hidden items-center -space-x-2 sm:flex" aria-hidden>
      {shown.map((u) => (
        <Initial key={u.id} user={u} className="border ring-2 ring-card" />
      ))}
      {more > 0 && <span className="flex h-7 min-w-7 items-center justify-center rounded-full border bg-muted px-1.5 text-xs text-muted-foreground ring-2 ring-card">+{more}</span>}
    </div>
  )
}

function CreateGroup({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (g: Group) => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'greydoc' | 'oidc'>('greydoc')
  const [oidc, setOidc] = useState('')
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const g = await api.post<Group>('/api/admin/groups', { name, oidc_group: kind === 'oidc' ? oidc : '' })
      setName('')
      setOidc('')
      setKind('greydoc')
      onCreated(g)
    } catch (err) {
      fail(err)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New group</DialogTitle>
          <DialogDescription>Choose where the members come from. You cannot change this later.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4" data-testid="create-group">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-name">Name</Label>
            <Input id="group-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-kind">Members</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as 'greydoc' | 'oidc')}>
              <SelectTrigger id="group-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="greydoc">Managed in greydoc</SelectItem>
                <SelectItem value="oidc">From an OIDC group</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {kind === 'oidc' ? 'Members come from your identity provider. You cannot add people here.' : 'You add and remove members on this page.'}
            </p>
          </div>
          {kind === 'oidc' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-oidc">OIDC group</Label>
              <Input id="group-oidc" value={oidc} onChange={(e) => setOidc(e.target.value)} className="font-mono" required />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Create group</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function MemberRow({ user, onRemove }: { user: User; onRemove?: () => void }) {
  return (
    <li className="flex h-11 items-center gap-3">
      <Initial user={user} />
      <span className="min-w-0 flex-1 truncate text-sm">
        {user.display_name || user.username} <span className="text-muted-foreground">{handle(user.username)}</span>
      </span>
      {onRemove && (
        <Button size="icon" variant="ghost" className="size-8" aria-label={`Remove ${user.username}`} onClick={onRemove}>
          <UserMinus className="size-4" />
        </Button>
      )}
    </li>
  )
}

function GroupDetail({ id, onChanged, onClose }: { id: string; onChanged: () => void; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [oidc, setOidc] = useState('')
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<User[]>([])
  const base = '/api/admin/groups/' + id

  const show = (d: Detail) => {
    setDetail(d)
    setName(d.group.name)
    setDescription(d.group.description)
    setOidc(d.group.oidc_group)
  }
  useEffect(() => {
    api.get<Detail>(base).then(show, fail)
  }, [base])
  useEffect(() => {
    if (!query) return
    const t = setTimeout(() => {
      api.get<{ users: User[] }>('/api/users?q=' + encodeURIComponent(query)).then((r) => setFound(r.users), fail)
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  if (!detail) return <div className="h-40" />
  const { group, members, notes } = detail
  const linked = group.oidc_group !== ''
  const dirty = name !== group.name || description !== group.description || oidc !== group.oidc_group
  const candidates = found.filter((u) => !members.some((m) => m.id === u.id))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await api.patch<Group>(base, { name, description, ...(linked ? { oidc_group: oidc } : {}) })
      show(await api.get<Detail>(base))
      onChanged()
      toast.success('Saved')
    } catch (err) {
      fail(err)
    }
  }
  const member = async (username: string, add: boolean) => {
    try {
      const path = `${base}/members/${encodeURIComponent(username)}`
      show(await (add ? api.put<Detail>(path) : api.del<Detail>(path)))
      setQuery('')
      onChanged()
    } catch (err) {
      fail(err)
    }
  }
  const destroy = async () => {
    const used = count(group.note_count, 'document', 'documents')
    if (!confirm(`Delete the group “${group.name}”? It is used by ${used}. Its members lose the access it gave.`)) return
    try {
      await api.del(base)
      onClose()
      onChanged()
    } catch (err) {
      fail(err)
    }
  }

  return (
    <div className="flex flex-col gap-6 border-t bg-muted/30 px-4 py-5" data-testid="group-detail">
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-name">Name</Label>
          <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {linked && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-oidc">OIDC group</Label>
            <Input id="edit-oidc" value={oidc} onChange={(e) => setOidc(e.target.value)} className="font-mono" />
          </div>
        )}
        <div className={cn('flex flex-col gap-1.5', linked && 'sm:col-span-2')}>
          <Label htmlFor="edit-description">Description</Label>
          <Input id="edit-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
        </div>
        {dirty && (
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={() => show(detail)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </div>
        )}
      </form>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Members · {members.length}</h3>
        {linked ? (
          <p className="text-sm text-muted-foreground">
            Change the members of <span className="font-mono">{group.oidc_group}</span> in your identity provider. A person shows here after their next sign-in.
          </p>
        ) : (
          <div className="relative">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add a person by name" aria-label="Add a member" />
            {query && (
              <div className="absolute inset-x-0 top-full z-10 mt-1 flex flex-col overflow-hidden rounded-md border bg-popover shadow-md">
                {candidates.map((u) => (
                  <button key={u.id} className="flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => member(u.username, true)}>
                    <UserPlus className="size-4 text-muted-foreground" /> {u.display_name || u.username}{' '}
                    <span className="text-muted-foreground">{handle(u.username)}</span>
                  </button>
                ))}
                {candidates.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">Nobody matches. A person must sign in once first.</div>}
              </div>
            )}
          </div>
        )}
        {members.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <ul className="flex flex-col divide-y" data-testid="group-members">
            {members.map((m) => (
              <MemberRow key={m.id} user={m} onRemove={linked ? undefined : () => member(m.username, false)} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Documents · {notes.length}</h3>
        {notes.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No document is shared with this group yet. Owners share from the Share dialog of a document.</p>
        ) : (
          <ul className="flex flex-col divide-y" data-testid="group-notes">
            {notes.map((n) => (
              <li key={n.id} className="flex h-11 items-center gap-3 text-sm">
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <Link to={'/n/' + n.alias} className="min-w-0 flex-1 truncate hover:underline">
                  {n.title || n.alias}
                  {n.in_trash && <span className="ml-2 text-xs text-muted-foreground">in the trash</span>}
                </Link>
                <span className="hidden truncate text-muted-foreground sm:block">{n.owner}</span>
                <span className="w-24 shrink-0 text-right text-muted-foreground">{levelLabels[n.level] ?? n.level}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-center justify-between border-t pt-4">
        <Button variant="ghost" className="-ml-3 text-destructive hover:text-destructive" onClick={destroy}>
          <Trash2 className="size-4" /> Delete group
        </Button>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  )
}

export default function Groups() {
  const { me } = useMe()
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const load = () => api.get<{ groups: Group[] }>('/api/admin/groups').then((r) => setGroups(r.groups), fail)
  useEffect(() => {
    if (me?.admin && !me.local_mode) load()
  }, [me])
  if (me && !me.authenticated) {
    location.href = loginHref()
    return null
  }
  const allowed = me?.admin && !me.local_mode

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Groups</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Owners share a document with a group they belong to. Changes show in the{' '}
              <Link to="/audit?kind=group" className="underline">
                audit log
              </Link>
              .
            </p>
          </div>
          {allowed && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New group
            </Button>
          )}
        </div>
        {me && !allowed ? (
          <p className="rounded-lg border border-dashed py-12 text-center text-muted-foreground">
            {me.local_mode ? 'Groups need sign-in through OIDC.' : 'Only admins manage groups.'}
          </p>
        ) : (
          <>
            <CreateGroup
              open={creating}
              onOpenChange={setCreating}
              onCreated={(g) => {
                setCreating(false)
                load()
                setSelected(g.id)
              }}
            />
            {groups?.length === 0 && <p className="rounded-lg border border-dashed py-12 text-center text-muted-foreground">No groups yet. Create one to share documents with a team.</p>}
            {!!groups?.length && (
              <ul className="flex flex-col divide-y overflow-hidden rounded-lg border bg-card" data-testid="group-list">
                {groups.map((g) => {
                  const open = selected === g.id
                  return (
                    <li key={g.id}>
                      <button
                        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
                        aria-expanded={open}
                        onClick={() => setSelected(open ? null : g.id)}
                      >
                        <Users className="size-5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{g.name}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {g.oidc_group ? (
                              <>
                                From OIDC <span className="font-mono">{g.oidc_group}</span>
                              </>
                            ) : (
                              'Managed in greydoc'
                            )}
                            {' · '}
                            {count(g.member_count, 'member', 'members')}
                            {' · '}
                            {count(g.note_count, 'document', 'documents')}
                            {g.description ? ` · ${g.description}` : ''}
                          </div>
                        </div>
                        <AvatarStack group={g} />
                        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
                      </button>
                      {open && <GroupDetail id={g.id} onChanged={load} onClose={() => setSelected(null)} />}
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </main>
    </div>
  )
}
