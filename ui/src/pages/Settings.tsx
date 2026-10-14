import { useEffect, useState } from 'react'
import { Copy, KeyRound, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { AppHeader } from '@/components/AppHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api'
import { loginHref, useMe } from '@/lib/me'
import { relativeTime } from '@/lib/time'

interface Token {
  id: string
  kind: 'pat' | 'refresh'
  label: string
  client_name?: string
  scope: string
  created_at: string
  last_used_at?: string
}

function CopyLine({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
      <Button
        size="icon"
        variant="outline"
        aria-label="Copy"
        onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success('Copied'))}
      >
        <Copy className="size-4" />
      </Button>
    </div>
  )
}

function CopyBlock({ value }: { value: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border bg-card p-3 pr-12 font-mono text-xs">{value}</pre>
      <Button
        size="icon"
        variant="outline"
        className="absolute top-2 right-2"
        aria-label="Copy"
        onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success('Copied'))}
      >
        <Copy className="size-4" />
      </Button>
    </div>
  )
}

export default function Settings() {
  const { me } = useMe()
  const [tokens, setTokens] = useState<Token[]>([])
  const [mcpURL, setMcpURL] = useState(location.origin + '/mcp')
  const [label, setLabel] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)

  const load = () =>
    api.get<{ tokens: Token[]; mcp_url: string }>('/api/tokens').then((r) => {
      setTokens(r.tokens)
      setMcpURL(r.mcp_url)
    })
  useEffect(() => {
    if (me?.authenticated) load()
  }, [me])

  if (me && !me.authenticated) {
    location.href = loginHref()
    return null
  }

  const create = async () => {
    const r = await api.post<{ token: string }>('/api/tokens', { label: label || 'personal token' })
    setFresh(r.token)
    setLabel('')
    load()
  }
  const revoke = async (t: Token) => {
    if (!confirm(`Revoke “${t.client_name || t.label}”?`)) return
    await api.del('/api/tokens/' + t.id)
    load()
  }

  const pats = tokens.filter((t) => t.kind === 'pat')
  const apps = tokens.filter((t) => t.kind === 'refresh')

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <Card>
          <CardHeader>
            <CardTitle>Connect an AI agent (MCP)</CardTitle>
            <CardDescription>
              Agents read, comment, suggest and edit with your rights. Each note's owner decides how far agents may go.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <Label>Server URL</Label>
            <CopyLine value={mcpURL} />
            <Label className="mt-2">Claude Code</Label>
            <CopyLine value={`claude mcp add --transport http greydoc ${mcpURL}`} />
            <Label className="mt-2">opencode</Label>
            <CopyBlock
              value={JSON.stringify(
                {
                  $schema: 'https://opencode.ai/config.json',
                  mcp: { greydoc: { type: 'remote', url: mcpURL, enabled: true } },
                },
                null,
                2,
              )}
            />
            <p className="text-muted-foreground">
              Add this to <code className="font-mono text-xs">opencode.json</code>
              {me?.local_mode ? '.' : <>, then run <code className="font-mono text-xs">opencode mcp auth greydoc</code> to sign in.</>}
            </p>
            <p className="text-muted-foreground">
              {me?.local_mode
                ? 'Local mode: no sign-in is needed.'
                : 'The client opens a browser window to sign you in. Clients without OAuth can send a personal token as “Authorization: Bearer …”.'}
            </p>
          </CardContent>
        </Card>

        {apps.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Connected agents</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col divide-y">
              {apps.map((t) => (
                <div key={t.id} className="flex items-center gap-3 py-2 text-sm">
                  <div className="flex-1">
                    <div className="font-medium">{t.client_name || t.label}</div>
                    <div className="text-xs text-muted-foreground">
                      Connected {relativeTime(t.created_at)}
                      {t.last_used_at ? ` · used ${relativeTime(t.last_used_at)}` : ''}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => revoke(t)}>
                    Disconnect
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Personal access tokens</CardTitle>
            <CardDescription>For scripts and MCP clients without OAuth. A token is shown once.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, for example laptop" />
              <Button onClick={create}>
                <KeyRound className="size-4" /> Create
              </Button>
            </div>
            {fresh && (
              <div className="rounded-md border border-primary/50 bg-primary/5 p-3 text-sm">
                <p className="mb-2">Copy this token now. It is not shown again.</p>
                <CopyLine value={fresh} />
              </div>
            )}
            <div className="flex flex-col divide-y">
              {pats.map((t) => (
                <div key={t.id} className="flex items-center gap-3 py-2 text-sm">
                  <div className="flex-1">
                    <div className="font-medium">{t.label}</div>
                    <div className="text-xs text-muted-foreground">
                      Created {relativeTime(t.created_at)}
                      {t.last_used_at ? ` · used ${relativeTime(t.last_used_at)}` : ' · never used'}
                      {t.scope === 'notes:read' ? ' · read only' : ''}
                    </div>
                  </div>
                  <Button size="icon" variant="ghost" aria-label="Revoke" onClick={() => revoke(t)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
