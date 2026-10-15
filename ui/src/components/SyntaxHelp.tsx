import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Kbd } from '@/components/ui/kbd'
import { renderMarkdown } from '@/render/markdown'
import { hydrateMermaid } from '@/render/mermaid'

type Entry = { label: string; src: string; render?: boolean }

const sections: { id: string; label: string; entries: Entry[] }[] = [
  {
    id: 'basics',
    label: 'Basics',
    entries: [
      { label: 'Headings', src: '# Title\n## Section\n### Subsection' },
      { label: 'Emphasis', src: '**bold** *italic* ~~deleted~~\n==marked== ++inserted++\nH~2~O and x^2^' },
      { label: 'Lists', src: '- item\n  - nested item\n1. first\n2. second' },
      { label: 'Tasks', src: '- [x] done\n- [ ] to do' },
      { label: 'Links', src: '[greydoc](https://example.com)\n<https://example.com>' },
      { label: 'Images', src: '![alt text](/favicon.svg)\n![wider](/favicon.svg =64x)' },
      { label: 'Quote', src: '> Text from someone else.' },
      { label: 'Code', src: 'Inline `code`.\n\n```js\nconst answer = 42\n```' },
      { label: 'Table', src: '| Name | Status |\n|:-----|:------:|\n| Search | Done |\n| SSO | Late |' },
      { label: 'Line', src: 'Above\n\n---\n\nBelow' },
      { label: 'Footnote', src: 'A claim.[^1]\n\n[^1]: The source.' },
      { label: 'Emoji', src: ':smile: :rocket: :warning:' },
    ],
  },
  {
    id: 'blocks',
    label: 'Blocks',
    entries: [
      { label: 'Alerts', src: '> [!NOTE]\n> Good to know.\n\n> [!WARNING]\n> Check this first.' },
      { label: 'Boxes', src: ':::info\nAlso success, warning and danger.\n:::' },
      { label: 'Spoiler', src: ':::spoiler Click to open\nHidden text.\n:::' },
      { label: 'Table of contents', src: '[toc]\n\n# Plan\n## Goals\n## Risks' },
      { label: 'Math', src: 'Inline $E = mc^2$.\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$' },
      { label: 'Diagram', src: '```mermaid\nflowchart LR\n  Draft --> Review --> Publish\n```' },
      { label: 'CSV table', src: '```csvpreview header="true"\nname,team\nAna,Search\nBo,Infra\n```' },
      { label: 'Definitions', src: 'Term\n: What the term means.' },
      { label: 'Abbreviations', src: 'The API is up.\n\n*[API]: Application Programming Interface' },
    ],
  },
  {
    id: 'notes',
    label: 'Notes and slides',
    entries: [
      { label: 'Tags and title', src: '---\ntitle: Q4 plan\ntags: [roadmap, q4]\ndescription: Shown in the note list\n---', render: false },
      { label: 'Slides', src: '# First slide\n\n---\n\n# Second slide\n\n----\n\n# Below the second slide\n\nnote: Speaker notes start here.', render: false },
      { label: 'Slide options', src: '---\nslideOptions:\n  theme: black\n  transition: fade\n  slideNumber: c/t\n---', render: false },
    ],
  },
]

const shortcuts: [string[], string][] = [
  [['Ctrl', 'Alt', 'L'], 'Live mode: Markdown renders as you type'],
  [['Ctrl', 'Alt', 'E'], 'Editor only'],
  [['Ctrl', 'Alt', 'B'], 'Editor and preview side by side'],
  [['Ctrl', 'Alt', 'V'], 'Preview only'],
  [['Select text'], 'Comment, suggest a change or ask the AI'],
  [['Esc'], 'In slide mode: show all slides'],
  [['D'], 'In slide mode: switch between light and dark'],
]

function Row({ entry }: { entry: Entry }) {
  const html = entry.render === false ? '' : renderMarkdown(entry.src).html
  return (
    <div className="grid grid-cols-[7rem_1fr_1fr] gap-4 border-b py-3 last:border-0">
      <div className="text-sm font-medium">{entry.label}</div>
      <pre className="self-start overflow-x-auto rounded-md border bg-card px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap select-all">{entry.src}</pre>
      {entry.render === false ? (
        <div className="text-xs text-muted-foreground">Not shown in the preview.</div>
      ) : (
        <div className="markdown-body help-sample min-w-0 text-sm" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  )
}

// SyntaxHelp is the Markdown cheat sheet, like HedgeDoc's help dialog. Each example is rendered by the real renderer.
export function SyntaxHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState('basics')
  const body = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => body.current && void hydrateMermaid(body.current, { interactive: false }), 0)
    return () => clearTimeout(t)
  }, [open, tab])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-4xl" data-testid="syntax-help">
        <DialogHeader>
          <DialogTitle>Markdown help</DialogTitle>
          <DialogDescription>
            Write the text on the left. The preview shows the result on the right. The{' '}
            <a href="/features" target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              features page
            </a>{' '}
            explains everything greydoc does.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1">
          <TabsList>
            {sections.map((s) => (
              <TabsTrigger key={s.id} value={s.id}>
                {s.label}
              </TabsTrigger>
            ))}
            <TabsTrigger value="keys">Shortcuts</TabsTrigger>
          </TabsList>
          <div ref={body} className="min-h-0 overflow-y-auto pr-2">
            {sections.map((s) => (
              <TabsContent key={s.id} value={s.id}>
                {s.entries.map((e) => (
                  <Row key={e.label} entry={e} />
                ))}
              </TabsContent>
            ))}
            <TabsContent value="keys">
              {shortcuts.map(([keys, what]) => (
                <div key={what} className="flex items-center gap-4 border-b py-2.5 text-sm last:border-0">
                  <span className="flex w-44 shrink-0 gap-1">
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                  <span>{what}</span>
                </div>
              ))}
              <p className="pt-3 text-xs text-muted-foreground">On a Mac, Cmd works in place of Ctrl.</p>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
