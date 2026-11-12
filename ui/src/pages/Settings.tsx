import { useEffect, useState } from 'react'
import { Copy, KeyRound, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { AppHeader } from '@/components/AppHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { defaultLiveStyle } from '@/editor/live'
import { api, setPrefs, type Prefs } from '@/lib/api'
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

// Steps numbers its Step children, one action each.
function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="mt-4 flex flex-col gap-5 [counter-reset:step]">{children}</ol>
}

function Step({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3 [counter-increment:step]">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground before:content-[counter(step)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
        <div className="font-medium">{title}</div>
        {children}
      </div>
    </li>
  )
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

function Choice<T extends string>({ label, hint, value, options, onChange }: { label: string; hint: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-muted-foreground">{hint}</div>
      </div>
      <ToggleGroup type="single" variant="outline" size="sm" value={value} onValueChange={(v) => v && onChange(v as T)} aria-label={label} className="w-fit">
        {options.map(([v, name]) => (
          <ToggleGroupItem key={v} value={v} aria-label={name} className="px-3">
            {name}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

// EditorPrefs is the editor card. The choices are stored on the account, so they follow the user to every browser.
function EditorPrefs() {
  const { me, reload } = useMe()
  const prefs = me?.prefs ?? {}
  const save = (p: Prefs) =>
    setPrefs(p)
      .then(reload)
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
  return (
    <Card data-testid="editor-prefs">
      <CardHeader>
        <CardTitle>Editor</CardTitle>
        <CardDescription>How documents open for you. The buttons above a document change only that document, in that tab.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 text-sm">
        <Choice
          label="Open documents in"
          hint="Live shows the document as it reads and lets you edit it in place."
          value={prefs.default_mode ?? 'live'}
          options={[
            ['live', 'Live'],
            ['editor', 'Editor'],
            ['split', 'Split'],
            ['preview', 'Preview'],
          ]}
          onChange={(v) => save({ default_mode: v })}
        />
        <Choice
          label="Live style"
          hint="Document never shows Markdown. Obsidian shows the Markdown of the line you edit."
          value={prefs.live_style ?? defaultLiveStyle}
          options={[
            ['document', 'Document'],
            ['obsidian', 'Obsidian'],
          ]}
          onChange={(v) => save({ live_style: v })}
        />
      </CardContent>
    </Card>
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
        <EditorPrefs />
        <Card>
          <CardHeader>
            <CardTitle>Connect an AI agent (MCP)</CardTitle>
            <CardDescription>
              Agents read, comment, suggest and edit with your rights. Each document's owner decides how far agents may go.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <Tabs defaultValue="opencode" data-testid="mcp-setup">
              <TabsList>
                <TabsTrigger value="opencode">opencode</TabsTrigger>
                <TabsTrigger value="claude">Claude Code</TabsTrigger>
                <TabsTrigger value="other">Other clients</TabsTrigger>
              </TabsList>
              <TabsContent value="opencode">
                <Steps>
                  <Step title="Add greydoc to opencode.json, in your project or in ~/.config/opencode/">
                    <CopyBlock
                      value={JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { greydoc: { type: 'remote', url: mcpURL, enabled: true } } }, null, 2)}
                    />
                  </Step>
                  {!me?.local_mode && (
                    <Step title="Sign in: run this command and pick greydoc in the list">
                      <CopyLine value="opencode mcp auth" />
                      <p className="text-muted-foreground">A browser window opens. Choose Allow. Run the command again when opencode reports that greydoc needs a sign-in.</p>
                    </Step>
                  )}
                  <Step title="Start opencode and ask about your documents">
                    <p className="text-muted-foreground">For example: “List my greydoc documents about the roadmap.”</p>
                  </Step>
                </Steps>
              </TabsContent>
              <TabsContent value="claude">
                <Steps>
                  <Step title="Add greydoc to Claude Code">
                    <CopyLine value={`claude mcp add --transport http greydoc ${mcpURL}`} />
                  </Step>
                  {!me?.local_mode && (
                    <Step title="Sign in: in Claude Code, run /mcp, pick greydoc, then Authenticate">
                      <CopyLine value="/mcp" />
                      <p className="text-muted-foreground">A browser window opens. Choose Allow. Do it again when Claude Code reports that greydoc needs a sign-in.</p>
                    </Step>
                  )}
                  <Step title="Ask Claude about your documents">
                    <p className="text-muted-foreground">For example: “List my greydoc documents about the roadmap.”</p>
                  </Step>
                </Steps>
              </TabsContent>
              <TabsContent value="other">
                <Steps>
                  <Step title="Add a remote MCP server (Streamable HTTP) with this URL">
                    <CopyLine value={mcpURL} />
                  </Step>
                  {!me?.local_mode && (
                    <Step title="Sign in">
                      <p className="text-muted-foreground">
                        Clients with OAuth sign in through the browser. Other clients send a personal access token, created below, as{' '}
                        <code className="font-mono text-xs">Authorization: Bearer …</code>
                      </p>
                    </Step>
                  )}
                </Steps>
              </TabsContent>
            </Tabs>
            {me?.local_mode && <p className="mt-3 text-muted-foreground">Local mode: agents need no sign-in.</p>}
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
