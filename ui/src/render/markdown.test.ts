import { describe, expect, it } from 'vitest'
import { headingsOf, originalSrc, renderMarkdown } from '@/render/markdown'
import { diagramUsesElk, mermaidConfig } from '@/render/mermaidTheme'

const html = (src: string) => renderMarkdown(src).html

describe('markdown extensions', () => {
  it('renders mentions as chips, but not in code or after a backslash', () => {
    const out = html('Hi [@Alice <b>](@Alice), see `[@B](@bob)` and \\[@C](@carol).')
    expect(out).toContain('<span class="mention" data-user="alice">@Alice &lt;b&gt;</span>')
    expect(out).toContain('<code>[@B](@bob)</code>')
    expect(out).not.toContain('data-user="carol"')
    expect(html('[@x](https://x.org)')).toContain('href="https://x.org"')
  })
  it('links to other notes with [[alias]] and [[alias|label]]', () => {
    const out = html('See [[Q4-Roadmap]] and [[incident-search|the incident]].')
    expect(out).toContain('<a href="/n/q4-roadmap" class="note-link" data-alias="q4-roadmap">q4-roadmap</a>')
    expect(out).toContain('<a href="/n/incident-search" class="note-link" data-alias="incident-search" data-label="1">the incident</a>')
    expect(html('[[toc]]\n\n# A')).toContain('class="toc"')
    expect(html('[[not an alias]]')).not.toContain('note-link')
  })
  it('links to a heading of another note with [[alias#section]]', () => {
    expect(html('[[q4#risks]]')).toContain('<a href="/n/q4#risks" class="note-link" data-alias="q4" data-section="risks">q4 › risks</a>')
    expect(html('[[q4#risks|the risks]]')).toContain('<a href="/n/q4#risks" class="note-link" data-alias="q4" data-section="risks" data-label="1">the risks</a>')
    expect(html('[[q4#Release Plan]]')).toContain('href="/n/q4#release-plan"')
    expect(html('[[q4#]]')).not.toContain('note-link')
    expect(html('[[toc]]\n\n# A')).toContain('class="toc"')
  })
  it('lists the headings of a note with their ids', () => {
    expect(headingsOf('---\ntitle: x\n---\n# Intro\n\ntext\n\n## Release *plan*\n\n## Intro')).toEqual([
      { level: 1, text: 'Intro', id: 'intro' },
      { level: 2, text: 'Release plan', id: 'release-plan' },
      { level: 2, text: 'Intro', id: 'intro-1' },
    ])
  })
  it('keeps image width and height, which base CSS would override', () => {
    expect(html('<img src="/a.png" height="80px">')).toMatch(/style="height: ?80px;?"/)
    expect(html('<img src="/a.png" width="120" height="50%">')).toMatch(/style="width: ?120px; ?height: ?50%;?"/)
    expect(html('![logo](/a.png =40x30)')).toMatch(/style="width: ?40px; ?height: ?30px;?"/)
    expect(html('<img src="/a.png" height="1;background:red">')).not.toContain('style=')
  })
  it('renders GFM tables and strikethrough', () => {
    const out = html('| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~')
    expect(out).toContain('<table data-line="0" data-line-end="3">')
    expect(out).toContain('<td>1</td>')
    expect(out).toContain('<s>gone</s>')
  })
  it('renders task lists', () => {
    const out = html('- [x] done\n- [ ] todo')
    expect(out).toContain('type="checkbox"')
    expect(out).toMatch(/checked/)
  })
  it('adds heading anchors and a table of contents', () => {
    const out = html('[toc]\n\n# First\n\n## Second part')
    expect(out).toContain('id="first"')
    expect(out).toContain('class="toc"')
    expect(out).toContain('href="#second-part"')
  })
  it('puts a link icon with no text in each heading', () => {
    const out = html('[toc]\n\n## Second part')
    expect(out).toMatch(/<h2 id="second-part"[^>]*><a class="header-anchor" href="#second-part" aria-label="Link to this section"><\/a>Second part<\/h2>/)
    expect(out).toContain('<a href="#second-part">Second part</a>')
  })
  it('renders HedgeDoc containers and spoilers', () => {
    const out = html(':::warning\nCareful\n:::\n\n:::spoiler Click me\nhidden\n:::')
    expect(out).toContain('class="alert alert-warning"')
    expect(out).toContain('<details')
    expect(out).toContain('<summary>Click me</summary>')
  })
  it('renders GitHub alerts', () => {
    const out = html('> [!NOTE]\n> Useful information.')
    expect(out).toContain('class="alert alert-note"')
    expect(out).not.toContain('[!NOTE]')
  })
  it('renders emoji shortcodes', () => {
    expect(html(':smile:')).toContain('😄')
  })
  it('renders KaTeX inline and block math', () => {
    const out = html('Inline $x^2$ and\n\n$$\n\\frac{a}{b}\n$$')
    expect(out).toContain('class="katex"')
    expect(out).toContain('katex-display')
  })
  it('highlights fenced code and keeps the language class', () => {
    const out = html('```js\nconst x = 1\n```')
    expect(out).toContain('class="hljs language-js"')
    expect(out).toContain('hljs-keyword')
  })
  it('supports HedgeDoc image size syntax', () => {
    const out = html('![logo](https://example.com/a.png =120x80)')
    expect(out).toContain('width="120"')
    expect(out).toContain('height="80"')
    expect(out).toContain('alt="logo"')
  })
  it('renders csvpreview fences as tables', () => {
    const out = html('```csvpreview {header="true"}\nname,age\nAda,36\n```')
    expect(out).toContain('<th>name</th>')
    expect(out).toContain('<td>Ada</td>')
  })
  it('renders mark, sub, sup, ins, footnotes, abbr and deflists', () => {
    const out = html('==hi== H~2~O x^2^ ++new++ note[^1]\n\n[^1]: foot\n\n*[HTML]: Hyper Text\n\nHTML\n\nTerm\n:   Definition')
    expect(out).toContain('<mark>hi</mark>')
    expect(out).toContain('<sub>2</sub>')
    expect(out).toContain('<sup>2</sup>')
    expect(out).toContain('<ins>new</ins>')
    expect(out).toContain('footnote')
    expect(out).toContain('<abbr title="Hyper Text">HTML</abbr>')
    expect(out).toMatch(/<dt[^>]*>Term<\/dt>/)
  })
  it('turns mermaid fences into placeholders with the source', () => {
    const out = html('```mermaid\ngraph TD; A-->B\n```')
    expect(out).toContain('class="mermaid-block"')
    expect(out).toContain('graph TD; A--&gt;B')
  })
  it('marks block elements with their source line', () => {
    const out = html('# A\n\npara\n\n- item')
    expect(out).toMatch(/<h1[^>]* data-line="0" data-line-end="1"/)
    expect(out).toContain('<p data-line="2" data-line-end="3"')
    expect(out).toContain('<ul data-line="4" data-line-end="5"')
  })
  it('marks table rows and nested blocks with their source lines', () => {
    const table = html('| a |\n|---|\n| 1 |\n| 2 |')
    expect(table).toContain('<tr data-line="0" data-line-end="1">')
    expect(table).toContain('<tr data-line="3" data-line-end="4">')
    expect(html('> one\n>\n> two')).toContain('<p data-line="2" data-line-end="3">two</p>')
    expect(html(':::info\nfirst\n\nsecond\n:::')).toContain('<p data-line="3" data-line-end="4">second</p>')
    expect(html('> [!NOTE]\n> first\n>\n> second')).toContain('<p data-line="3" data-line-end="4">second</p>')
  })
  it('marks the start and the end of math, code and diagrams', () => {
    expect(html('$$\nx^2\n$$')).toMatch(/<p class="katex-block" data-line="0" data-line-end="3"/)
    expect(html('```js\nlet a\n```')).toContain('data-line="0" data-line-end="3"')
    expect(html('text\n\n```mermaid\ngraph TD; A-->B\n```')).toContain('<div class="mermaid-block" data-line="2" data-line-end="5">')
    expect(html('```csvpreview\na,b\n```')).toContain('<table class="csv-table" data-line="0" data-line-end="3">')
  })
  it('hides front matter and returns it', () => {
    const r = renderMarkdown('---\ntitle: X\ntags: [a]\n---\n# Body')
    expect(r.html).not.toContain('title: X')
    expect(r.frontMatter?.title).toBe('X')
    expect(r.html).toContain('data-line="4"')
  })
  it('links bare URLs', () => {
    expect(html('see https://example.com')).toContain('href="https://example.com"')
  })
})

describe('sanitizing', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '[x](javascript:alert(1))',
    '<iframe src="https://evil.example"></iframe>',
    '<svg><script>alert(1)</script></svg>',
    '<div onclick="alert(1)">x</div>',
    '<style>body{display:none}</style>',
    '<object data="x"></object>',
    '<form action="https://evil.example"><input name=a></form>',
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  ]
  for (const p of payloads) {
    it(`strips ${p.slice(0, 40)}`, () => {
      const out = html(p).toLowerCase()
      expect(out).not.toContain('<script')
      expect(out).not.toMatch(/\son[a-z]+=/)
      expect(out).not.toMatch(/(href|src)="\s*javascript:/)
      expect(out).not.toContain('<iframe')
      expect(out).not.toContain('<style')
      expect(out).not.toContain('<object')
      expect(out).not.toContain('<form')
      expect(out).not.toMatch(/(href|src)="data:text\/html/)
    })
  }
  it('keeps safe HTML', () => {
    const out = html('<details><summary>s</summary>body</details> <kbd>Ctrl</kbd>')
    expect(out).toContain('<details>')
    expect(out).toContain('<kbd>Ctrl</kbd>')
  })
})

describe('mermaid theme', () => {
  it('uses Greyhaven tokens, ELK layout and strict security', () => {
    const light = mermaidConfig('light')
    expect(light.securityLevel).toBe('strict')
    expect(light.layout).toBeUndefined()
    expect(mermaidConfig('light', true).layout).toBe('elk')
    expect(light.theme).toBe('base')
    expect(light.themeVariables?.dropShadow).toBe('none')
    expect(light.themeVariables?.useGradient).toBe(false)
    expect(light.look).toBe('classic')
    expect(String(light.themeVariables?.fontFamily)).toContain('Aspekta')
    expect(mermaidConfig('dark').themeVariables?.primaryColor).not.toBe(light.themeVariables?.primaryColor)
  })
})

describe('ELK layout', () => {
  it('applies only to diagrams that support it', () => {
    expect(diagramUsesElk('flowchart LR\nA-->B')).toBe(true)
    expect(diagramUsesElk('%% comment\ngraph TD\nA-->B')).toBe(true)
    expect(diagramUsesElk('---\ntitle: x\n---\nstateDiagram-v2\n[*]-->A')).toBe(true)
    expect(diagramUsesElk('mindmap\n  root')).toBe(false)
    expect(diagramUsesElk('sequenceDiagram\nA->>B: hi')).toBe(false)
  })
})

describe('originalSrc', () => {
  const hex = '0123456789abcdef0123456789abcdef'
  it('drops the resize query of a large upload', () => {
    expect(originalSrc(`/uploads/${hex}.png?w=1600`)).toBe(`/uploads/${hex}.png`)
    expect(originalSrc(`/uploads/${hex}.jpg?w=1600`)).toBe(`/uploads/${hex}.jpg`)
  })
  it('keeps other addresses', () => {
    expect(originalSrc('https://example.com/a.png?w=1600')).toBe('https://example.com/a.png?w=1600')
    expect(originalSrc(`/uploads/${hex}.gif`)).toBe(`/uploads/${hex}.gif`)
  })
})
