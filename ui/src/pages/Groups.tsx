import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Trash2, UserMinus, UserPlus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { AppHeader } from '@/components/AppHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, type Group, type User } from '@/lib/api'
import { loginHref, useMe } from '@/lib/me'

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e))

function membersLabel(g: Group) {
  return `${g.member_count} ${g.member_count === 1 ? 'member' : 'members'}`
}

function CreateGroup({ onCreated }: { onCreated: (g: Group) => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'greydoc' | 'oidc'>('greydoc')
  const [oidc, setOidc] = useState('')
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const g = await api.post<Group>('/api/admin/groups', { name, oidc_group: kind === 'oidc' ? oidc : '' })
      setName('')
      setOidc('')
      onCreated(g)
    } catch (err) {
      fail(err)
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-4" data-testid="create-group">
      <div className="flex min-w-40 flex-1 flex-col gap-1.5">
        <Label htmlFor="group-name" className="text-xs text-muted-foreground">
          Name
        </Label>
        <Input id="group-name" value={name} onChange={(e) => setName(e.target.value)} className="h-8" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">Members</Label>
        <Select value={kind} onValueChange={(v) => setKind(v as 'greydoc' | 'oidc')}>
          <SelectTrigger className="h-8 w-48 text-xs" aria-label="Members">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="greydoc" className="text-xs">
              Managed in greydoc
            </SelectItem>
            <SelectItem value="oidc" className="text-xs">
              From an OIDC group
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {kind === 'oidc' && (
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor="group-oidc" className="text-xs text-muted-foreground">
            OIDC group
          </Label>
          <Input id="group-oidc" value={oidc} onChange={(e) => setOidc(e.target.value)} className="h-8 font-mono text-xs" required />
        </div>
      )}
      <Button type="submit" size="sm">
        Create group
      </Button>
    </form>
  )
}

function GroupDetail({ id, onChanged, onDeleted }: { id: string; onChanged: () => void; onDeleted: () => void }) {
  const [group, setGroup] = useState<Group | null>(null)
  const [members, setMembers] = useState<User[]>([])
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [oidc, setOidc] = useState('')
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<User[]>([])

  const show = (r: { group: Group; members: User[] }) => {
    setGroup(r.group)
    setMembers(r.members)
    setName(r.group.name)
    setDescription(r.group.description)
    setOidc(r.group.oidc_group)
  }
  useEffect(() => {
    api.get<{ group: Group; members: User[] }>('/api/admin/groups/' + id).then(show, fail)
  }, [id])
  useEffect(() => {
    if (!query) return
    const t = setTimeout(() => {
      api.get<{ users: User[] }>('/api/users?q=' + encodeURIComponent(query)).then((r) => setFound(r.users), fail)
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  if (!group) return null
  const linked = group.oidc_group !== ''
  const base = '/api/admin/groups/' + id

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await api.patch<Group>(base, { name, description, ...(linked ? { oidc_group: oidc } : {}) })
      show(await api.get(base))
      onChanged()
      toast.success('Saved')
    } catch (err) {
      fail(err)
    }
  }
  const member = async (username: string, add: boolean) => {
    try {
      const path = `${base}/members/${encodeURIComponent(username)}`
      show(await (add ? api.put<{ group: Group; members: User[] }>(path) : api.del<{ group: Group; members: User[] }>(path)))
      setQuery('')
      onChanged()
    } catch (err) {
      fail(err)
    }
  }
  const destroy = async () => {
    const used = group.note_count === 1 ? 'used by 1 document' : `used by ${group.note_count} documents`
    if (!confirm(`Delete the group “${group.name}”? It is ${used}. Its members lose the access it gave.`)) return
    try {
      await api.del(base)
      onDeleted()
    } catch (err) {
      fail(err)
    }
  }

  return (
    <div className="flex flex-col gap-5 rounded-lg border bg-card p-4" data-testid="group-detail">
      <form onSubmit={save} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <div className="flex min-w-40 flex-1 flex-col gap-1.5">
            <Label htmlFor="edit-name" className="text-xs text-muted-foreground">
              Name
            </Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} className="h-8" />
          </div>
          {linked && (
            <div className="flex min-w-40 flex-1 flex-col gap-1.5">
              <Label htmlFor="edit-oidc" className="text-xs text-muted-foreground">
                OIDC group
              </Label>
              <Input id="edit-oidc" value={oidc} onChange={(e) => setOidc(e.target.value)} className="h-8 font-mono text-xs" />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-description" className="text-xs text-muted-foreground">
            Description
          </Label>
          <Input id="edit-description" value={description} onChange={(e) => setDescription(e.target.value)} className="h-8" />
        </div>
        <div className="flex items-center justify-between">
          <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={destroy}>
            <Trash2 className="size-4" /> Delete group
          </Button>
          <Button type="submit" size="sm" variant="outline">
            Save
          </Button>
        </div>
      </form>

      <section className="flex flex-col gap-2">
        <div className="text-sm font-medium">Members</div>
        {linked ? (
          <p className="text-xs text-muted-foreground">
            Change the members of <span className="font-mono">{group.oidc_group}</span> in your identity provider. A person shows here after their next sign-in.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add a person who signed in once" className="h-8" aria-label="Add a member" />
            {query && (
              <div className="flex flex-col rounded-md border">
                {found
                  .filter((u) => !members.some((m) => m.id === u.id))
                  .map((u) => (
                    <button key={u.id} className="flex items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => member(u.username, true)}>
                      <UserPlus className="size-3.5" /> {u.display_name || u.username} <span className="text-muted-foreground">@{u.username}</span>
                    </button>
                  ))}
                {found.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">Nobody matches.</div>}
              </div>
            )}
          </div>
        )}
        {members.length === 0 && <p className="text-sm text-muted-foreground">No members yet.</p>}
        <ul className="flex flex-col divide-y rounded-md border" data-testid="group-members">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="flex-1">
                {m.display_name || m.username} <span className="text-muted-foreground">@{m.username}</span>
              </span>
              {!linked && (
                <Button size="icon" variant="ghost" aria-label={`Remove ${m.username}`} onClick={() => member(m.username, false)}>
                  <UserMinus className="size-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export default function Groups() {
  const { me } = useMe()
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const load = () => api.get<{ groups: Group[] }>('/api/admin/groups').then((r) => setGroups(r.groups), fail)
  useEffect(() => {
    if (me?.admin && !me.local_mode) load()
  }, [me])
  if (me && !me.authenticated) {
    location.href = loginHref()
    return null
  }

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Groups</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Owners share a document with a group they belong to. Changes show in the <Link to="/audit?kind=group" className="underline">audit log</Link>.
          </p>
        </div>
        {me && (!me.admin || me.local_mode) ? (
          <p className="rounded-lg border border-dashed py-12 text-center text-muted-foreground">
            {me.local_mode ? 'Groups need sign-in through OIDC.' : 'Only admins manage groups.'}
          </p>
        ) : (
          <>
            <CreateGroup
              onCreated={(g) => {
                load()
                setSelected(g.id)
              }}
            />
            {groups?.length === 0 && <p className="rounded-lg border border-dashed py-12 text-center text-muted-foreground">No groups yet.</p>}
            <ul className="flex flex-col divide-y rounded-lg border bg-card" data-testid="group-list">
              {groups?.map((g) => (
                <li key={g.id}>
                  <button className={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted ${selected === g.id ? 'bg-muted' : ''}`} onClick={() => setSelected(selected === g.id ? null : g.id)}>
                    <Users className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{g.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {g.oidc_group ? (
                          <>
                            From OIDC <span className="font-mono">{g.oidc_group}</span>
                          </>
                        ) : (
                          'Managed in greydoc'
                        )}
                        {' · '}
                        {membersLabel(g)}
                        {' · '}
                        {g.note_count === 1 ? '1 document' : `${g.note_count} documents`}
                        {g.description ? ` · ${g.description}` : ''}
                      </div>
                    </div>
                  </button>
                  {selected === g.id && (
                    <div className="px-4 pb-4">
                      <GroupDetail
                        id={g.id}
                        onChanged={load}
                        onDeleted={() => {
                          setSelected(null)
                          load()
                        }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  )
}
