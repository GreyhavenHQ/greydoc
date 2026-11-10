import { ensureSyntaxTree, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { tagHighlighter, tags } from '@lezer/highlight'
import { EditorState, Facet, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import katex from 'katex'
import { renderMarkdown } from '@/render/markdown'
import { naturalSize, renderMermaid, themeMode } from '@/render/mermaid'
import { splitFrontMatter } from '@/lib/meta'
import { mentionsOn } from '@/lib/mentions'

// Live preview: Markdown that renders in place, like Obsidian. Lines and blocks under a selection show their source.

const hide = Decoration.replace({})

function revealAt(view: EditorView, dom: HTMLElement) {
  const pos = view.posAtDOM(dom)
  view.dispatch({ selection: { anchor: pos } })
  view.focus()
}

class MermaidWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly mode: 'light' | 'dark',
  ) {
    super()
  }
  eq(o: MermaidWidget) {
    return o.src === this.src && o.mode === this.mode
  }
  get estimatedHeight() {
    return 240
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div')
    el.className = 'cm-lp-block cm-lp-mermaid'
    el.textContent = 'Rendering diagram…'
    void renderMermaid(this.src, this.mode).then((svg) => {
      el.innerHTML = svg
      naturalSize(el)
      view.requestMeasure()
    })
    el.onmousedown = (e) => {
      e.preventDefault()
      revealAt(view, el)
    }
    return el
  }
  ignoreEvent() {
    return false
  }
}

class HTMLBlockWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly cls: string,
  ) {
    super()
  }
  eq(o: HTMLBlockWidget) {
    return o.html === this.html
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div')
    el.className = 'cm-lp-block markdown-body ' + this.cls
    el.innerHTML = this.html
    el.onmousedown = (e) => {
      if ((e.target as HTMLElement).closest('a')) return
      e.preventDefault()
      revealAt(view, el)
    }
    return el
  }
  ignoreEvent() {
    return false
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super()
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.display === this.display
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'cm-lp-block cm-lp-math' : 'cm-lp-math-inline'
    el.innerHTML = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: false })
    el.onmousedown = (e) => {
      e.preventDefault()
      revealAt(view, el)
    }
    return el
  }
  ignoreEvent() {
    return false
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super()
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt
  }
  toDOM() {
    const img = document.createElement('img')
    img.className = 'cm-lp-img'
    img.src = /^(https?:|\/)/.test(this.src) ? this.src : ''
    img.alt = this.alt
    return img
  }
}

class BulletWidget extends WidgetType {
  constructor(readonly label: string) {
    super()
  }
  eq(o: BulletWidget) {
    return o.label === this.label
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = this.label === '•' ? 'cm-lp-bullet' : 'cm-lp-bullet cm-lp-number'
    el.textContent = this.label
    return el
  }
}

class LabelWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly cls: string,
  ) {
    super()
  }
  eq(o: LabelWidget) {
    return o.text === this.text && o.cls === this.cls
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = this.cls
    el.textContent = this.text
    return el
  }
}

// canToggleTasks says whether this user may tick task boxes. People who can only comment or read cannot.
export const canToggleTasks = Facet.define<() => boolean, () => boolean>({
  combine: (v) => v[0] ?? (() => true),
})

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-check'
    box.checked = this.checked
    const allowed = () => !view.state.readOnly && view.state.facet(canToggleTasks)()
    box.disabled = !allowed()
    box.onmousedown = (e) => e.preventDefault()
    box.onclick = (e) => {
      e.preventDefault()
      if (!allowed()) return
      const pos = view.posAtDOM(box)
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' }, userEvent: 'input.toggle' })
    }
    return box
  }
  ignoreEvent() {
    return false
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-lp-hr'
    return el
  }
}

// FrontMatterWidget shows the front matter as one line: the title and the tags. Click to edit the YAML.
class FrontMatterWidget extends WidgetType {
  constructor(
    readonly title: string,
    readonly tags: string[],
    readonly keys: number,
  ) {
    super()
  }
  eq(o: FrontMatterWidget) {
    return o.title === this.title && o.tags.join('\n') === this.tags.join('\n') && o.keys === this.keys
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div')
    el.className = 'cm-lp-props'
    el.title = 'Front matter. Click to edit.'
    el.setAttribute('data-testid', 'front-matter')
    if (this.title) {
      const t = document.createElement('span')
      t.className = 'cm-lp-props-title'
      t.textContent = this.title
      el.appendChild(t)
    }
    for (const tag of this.tags) {
      const chip = document.createElement('span')
      chip.className = 'cm-lp-props-tag'
      chip.textContent = tag
      el.appendChild(chip)
    }
    const rest = this.keys - (this.title ? 1 : 0) - (this.tags.length ? 1 : 0)
    if (rest > 0 || el.childElementCount === 0) {
      const more = document.createElement('span')
      more.className = 'cm-lp-props-more'
      more.textContent = el.childElementCount === 0 ? 'Front matter' : `+${rest} more`
      el.appendChild(more)
    }
    el.onmousedown = (e) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: view.state.doc.line(2).from } })
      view.focus()
    }
    return el
  }
  ignoreEvent() {
    return false
  }
}

function frontMatterEnd(state: EditorState): number {
  const doc = state.doc
  if (doc.lines < 2 || !/^-{3,}$/.test(doc.line(1).text)) return -1
  const open = doc.line(1).text
  for (let n = 2; n <= doc.lines; n++) {
    const t = doc.line(n).text
    if (t.length === open.length && /^(?:-{3,}|\.{3,})$/.test(t)) return doc.line(n).to
  }
  return -1
}

export function liveDecorations(state: EditorState): DecorationSet {
  const doc = state.doc
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state)
  const ranges = state.selection.ranges
  const touches = (from: number, to: number) => ranges.some((r) => r.from <= to && r.to >= from)
  const lineActive = (pos: number) => {
    const l = doc.lineAt(pos)
    return touches(l.from, l.to)
  }
  const out: Range<Decoration>[] = []
  const mode = typeof document === 'undefined' ? 'light' : themeMode()
  const lineClass = (from: number, to: number, cls: string) => {
    for (let pos = from; pos <= to; ) {
      const l = doc.lineAt(pos)
      out.push(Decoration.line({ class: cls }).range(l.from))
      pos = l.to + 1
    }
  }
  const code: [number, number][] = []
  let alertTo = -1

  const fmEnd = frontMatterEnd(state)
  if (fmEnd > 0) {
    if (touches(0, fmEnd)) {
      lineClass(0, fmEnd, 'cm-lp-fm')
    } else {
      const { data } = splitFrontMatter(doc.sliceString(0, fmEnd) + '\n')
      const tags = Array.isArray(data?.tags) ? data.tags.map(String) : []
      const title = typeof data?.title === 'string' ? data.title : ''
      const keys = data ? Object.keys(data).length : 0
      out.push(Decoration.replace({ widget: new FrontMatterWidget(title, tags, keys), block: true }).range(0, fmEnd))
    }
  }

  tree.iterate({
    enter(node) {
      if (node.from < fmEnd) return node.to <= fmEnd ? false : undefined
      const name = node.name
      const parent = node.node.parent?.name ?? ''
      const heading = /^ATXHeading(\d)$/.exec(name) ?? /^SetextHeading(\d)$/.exec(name)
      if (heading) {
        lineClass(node.from, node.to, 'cm-lp-h cm-lp-h' + heading[1])
        return
      }
      switch (name) {
        case 'HeaderMark': {
          if (!parent.startsWith('ATXHeading') || lineActive(node.from)) return
          const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
          if (node.from === doc.lineAt(node.from).from) out.push(hide.range(node.from, end))
          else out.push(hide.range(node.from - (doc.sliceString(node.from - 1, node.from) === ' ' ? 1 : 0), node.to))
          return
        }
        case 'Emphasis':
          out.push(Decoration.mark({ class: 'cm-lp-em' }).range(node.from, node.to))
          return
        case 'StrongEmphasis':
          out.push(Decoration.mark({ class: 'cm-lp-strong' }).range(node.from, node.to))
          return
        case 'Strikethrough':
          out.push(Decoration.mark({ class: 'cm-lp-strike' }).range(node.from, node.to))
          return
        case 'InlineCode':
          out.push(Decoration.mark({ class: 'cm-lp-code' }).range(node.from, node.to))
          return
        case 'EmphasisMark':
        case 'StrikethroughMark':
          if (!touches(node.from, node.to) && !lineActive(node.from)) out.push(hide.range(node.from, node.to))
          return
        case 'CodeMark':
          if (parent === 'InlineCode' && !lineActive(node.from)) out.push(hide.range(node.from, node.to))
          return
        case 'Link': {
          const cur = node.node
          const marks = cur.getChildren('LinkMark')
          // [toc] and [!NOTE] parse as links without a target. They are not links.
          if (!cur.getChild('URL') && marks.length < 3) return false
          if (doc.sliceString(node.from, node.from + 2) === '[@' && /\]\(@[^)]*\)$/.test(doc.sliceString(node.from, node.to))) {
            // Mention chips cover the link when mentions are on. Without them it reads as plain @Name.
            if (!mentionsOn() && marks.length >= 2 && !lineActive(node.from)) {
              out.push(hide.range(marks[0].from, marks[0].to))
              out.push(hide.range(marks[1].from, node.to))
            }
            return false
          }
          if (marks.length >= 2 && !lineActive(node.from)) {
            out.push(Decoration.mark({ class: 'cm-lp-link' }).range(marks[0].to, marks[1].from))
            out.push(hide.range(marks[0].from, marks[0].to))
            out.push(hide.range(marks[1].from, node.to))
          } else {
            out.push(Decoration.mark({ class: 'cm-lp-link' }).range(node.from, node.to))
          }
          return false
        }
        case 'URL':
        case 'Autolink':
          if (parent !== 'Link' && parent !== 'Image') out.push(Decoration.mark({ class: 'cm-lp-link' }).range(node.from, node.to))
          return false
        case 'Image': {
          if (lineActive(node.from)) return false
          const url = node.node.getChild('URL')
          const marks = node.node.getChildren('LinkMark')
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : ''
          let src = url ? doc.sliceString(url.from, url.to) : ''
          src = src.replace(/\s+=\d*x\d*$/, '')
          if (src) out.push(Decoration.replace({ widget: new ImageWidget(src, alt) }).range(node.from, node.to))
          return false
        }
        case 'Blockquote': {
          const first = doc.lineAt(node.from)
          const alert = /^>\s*\[!(note|tip|important|warning|caution)\]/i.exec(first.text)
          lineClass(node.from, node.to, 'cm-lp-quote' + (alert ? ' cm-lp-alert cm-lp-alert-' + alert[1].toLowerCase() : ''))
          out.push(Decoration.line({ class: 'cm-lp-first' }).range(first.from))
          out.push(Decoration.line({ class: 'cm-lp-last' }).range(doc.lineAt(node.to).from))
          if (alert && !lineActive(first.from)) {
            const name = alert[1][0].toUpperCase() + alert[1].slice(1).toLowerCase()
            out.push(Decoration.replace({ widget: new LabelWidget(name, 'cm-lp-alert-title') }).range(first.from, first.from + alert[0].length))
            alertTo = first.from + alert[0].length
          }
          return
        }
        case 'QuoteMark':
          if (node.to <= alertTo && node.from >= doc.lineAt(alertTo).from) return
          if (!lineActive(node.from)) {
            const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
            out.push(hide.range(node.from, end))
          }
          return
        case 'ListMark': {
          const mark = doc.sliceString(node.from, node.to)
          const task = node.node.nextSibling?.name === 'Task'
          const line = doc.lineAt(node.from)
          if (line.from !== doc.lineAt(node.node.parent!.from).from) return
          let depth = 0
          for (let p = node.node.parent; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') depth++
          // A hanging indent, like the view: wrapped lines start under the text, not under the bullet.
          const gap = depth > 1 || node.node.parent!.prevSibling ? '; padding-top: 0.2em' : ''
          out.push(Decoration.line({ attributes: { style: `padding-left: ${depth * 1.6}em; text-indent: -1.6em${gap}` } }).range(line.from))
          if (lineActive(node.from)) return
          const end = Math.min(node.to + 1, line.to)
          if (task) out.push(hide.range(line.from, end))
          else out.push(Decoration.replace({ widget: new BulletWidget(/^[-*+]$/.test(mark) ? '•' : mark) }).range(line.from, end))
          return
        }
        case 'TaskMarker':
          if (!lineActive(node.from)) {
            const checked = /x/i.test(doc.sliceString(node.from, node.to))
            out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to))
            if (checked) {
              const l = doc.lineAt(node.from)
              if (node.to + 1 < l.to) out.push(Decoration.mark({ class: 'cm-lp-done' }).range(node.to + 1, l.to))
            }
          }
          return
        case 'HorizontalRule':
          if (!lineActive(node.from)) out.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to))
          return
        case 'FencedCode': {
          code.push([node.from, node.to])
          const info = node.node.getChild('CodeInfo')
          const lang = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] : ''
          const textNode = node.node.getChild('CodeText')
          const src = textNode ? doc.sliceString(textNode.from, textNode.to) : ''
          const closed = node.node.getChildren('CodeMark').length >= 2
          if (lang === 'mermaid' && closed && !touches(node.from, node.to)) {
            out.push(Decoration.replace({ widget: new MermaidWidget(src, mode), block: true }).range(node.from, node.to))
            return false
          }
          lineClass(node.from, node.to, 'cm-lp-codeblock')
          out.push(Decoration.line({ class: 'cm-lp-first' }).range(doc.lineAt(node.from).from))
          out.push(Decoration.line({ class: 'cm-lp-last' }).range(doc.lineAt(node.to).from))
          for (const m of node.node.getChildren('CodeMark')) {
            lineClass(m.from, m.from, 'cm-lp-fence')
            const l = doc.lineAt(m.from)
            if (!touches(node.from, node.to) && l.length) {
              out.push(Decoration.replace({ widget: new LabelWidget(l.from === node.from ? lang : '', 'cm-lp-lang') }).range(l.from, l.to))
            }
          }
          return false
        }
        case 'CodeBlock':
          code.push([node.from, node.to])
          lineClass(node.from, node.to, 'cm-lp-codeblock')
          return false
        case 'Table': {
          if (touches(node.from, node.to)) {
            lineClass(node.from, node.to, 'cm-lp-table-src')
            return false
          }
          const html = renderMarkdown(doc.sliceString(node.from, node.to)).html
          out.push(Decoration.replace({ widget: new HTMLBlockWidget(html, 'cm-lp-table'), block: true }).range(node.from, node.to))
          return false
        }
      }
    },
  })

  // The view separates blocks with a 1em margin. A full blank line is taller, so it is shrunk.
  for (let n = 1; n <= doc.lines; n++) {
    const l = doc.line(n)
    if (l.from > fmEnd && l.length === 0 && !touches(l.from, l.to) && !code.some(([a, b]) => l.from > a && l.from < b))
      out.push(Decoration.line({ class: 'cm-lp-blank' }).range(l.from))
  }

  // Math is not in the Markdown grammar: find $$ blocks and $…$ spans outside code.
  const inCode = (pos: number) => code.some(([a, b]) => pos >= a && pos <= b)
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (line.from < fmEnd || inCode(line.from)) continue
    if (line.text.trim() === '$$') {
      let m = n + 1
      while (m <= doc.lines && doc.line(m).text.trim() !== '$$') m++
      if (m > doc.lines) break
      const end = doc.line(m)
      if (!touches(line.from, end.to)) {
        const tex = doc.sliceString(line.to + 1, end.from - 1)
        out.push(Decoration.replace({ widget: new MathWidget(tex, true), block: true }).range(line.from, end.to))
      }
      n = m
      continue
    }
    if (touches(line.from, line.to)) continue
    for (const m of line.text.matchAll(/==(?=\S)(.+?)(?<=\S)==/g)) {
      const from = line.from + m.index!
      if (inCode(from)) continue
      out.push(hide.range(from, from + 2))
      out.push(Decoration.mark({ class: 'cm-lp-mark' }).range(from + 2, from + m[0].length - 2))
      out.push(hide.range(from + m[0].length - 2, from + m[0].length))
    }
    if (!line.text.includes('$')) continue
    const re = /(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g
    for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
      const from = line.from + m.index
      if (inCode(from)) continue
      out.push(Decoration.replace({ widget: new MathWidget(m[1], false) }).range(from, from + m[0].length))
    }
  }

  return Decoration.set(out, true)
}

// refreshLive rebuilds the rendered blocks, for example after a theme change.
export const refreshLive = StateEffect.define<null>()

const liveField = StateField.define<DecorationSet>({
  create: (state) => liveDecorations(state),
  update(deco, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(refreshLive)) ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState)
    )
      return liveDecorations(tr.state)
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

// The values copy render/markdown.css, so live mode looks like the view. parity.spec.ts checks them.
const liveTheme = EditorView.theme({
  '&.cm-live': { backgroundColor: 'rgb(var(--background))' },
  '&.cm-live .cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.65' },
  '&.cm-live .cm-content': { maxWidth: 'calc(var(--doc-width, 728px) + 64px)', margin: '0 auto', padding: '40px 32px 30vh', fontSize: '16px' },
  '&.cm-live .cm-line': { padding: '0' },
  '.cm-lp-h': { fontWeight: '600', lineHeight: '1.25', paddingTop: '0.9em !important' },
  '.cm-lp-h1': { fontSize: '2em', letterSpacing: '-0.01em', paddingTop: '0.4em !important' },
  '.cm-lp-h2': { fontSize: '1.5em', paddingBottom: '0.3em !important', borderBottom: '1px solid rgb(var(--border) / 0.7)', marginBottom: '0.3em' },
  '.cm-lp-h3': { fontSize: '1.25em' },
  '.cm-lp-h4': { fontSize: '1em' },
  '.cm-lp-h5': { fontSize: '0.9em' },
  '.cm-lp-h6': { fontSize: '0.85em', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-blank': { fontSize: '0.55em' },
  '.cm-lp-em': { fontStyle: 'italic' },
  '.cm-lp-strong': { fontWeight: '700' },
  '.cm-lp-strike': { textDecoration: 'line-through' },
  '.cm-lp-done': { textDecoration: 'line-through', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-code': {
    fontFamily: 'var(--font-mono)', fontSize: '0.875em', backgroundColor: 'rgb(var(--muted))', border: '1px solid rgb(var(--border) / 0.6)',
    borderRadius: '4px', padding: '0.1em 0.35em',
  },
  '.cm-lp-link': { color: 'rgb(var(--primary))', textDecoration: 'underline', textUnderlineOffset: '2px' },
  '.cm-lp-quote': { borderLeft: '3px solid rgb(var(--border))', paddingLeft: '1em !important', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-codeblock': {
    fontFamily: 'var(--font-mono)', fontSize: '0.85em', lineHeight: '1.55', backgroundColor: 'rgb(var(--card))',
    padding: '0 1.1765em !important', borderLeft: '1px solid rgb(var(--border) / 0.7)', borderRight: '1px solid rgb(var(--border) / 0.7)',
  },
  '.cm-lp-codeblock.cm-lp-first': { borderTop: '1px solid rgb(var(--border) / 0.7)', borderTopLeftRadius: 'var(--radius)', borderTopRightRadius: 'var(--radius)' },
  '.cm-lp-codeblock.cm-lp-last': {
    borderBottom: '1px solid rgb(var(--border) / 0.7)', borderBottomLeftRadius: 'var(--radius)', borderBottomRightRadius: 'var(--radius)',
  },
  '.cm-lp-fence': { color: 'rgb(var(--muted-foreground) / 0.7)' },
  '.cm-lp-lang': { float: 'right', fontFamily: 'var(--font-sans)', fontSize: '0.8em', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-props': {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', padding: '4px 0 10px', cursor: 'pointer',
    fontSize: '12px', color: 'rgb(var(--muted-foreground))', whiteSpace: 'normal',
  },
  '.cm-lp-props-title': { fontWeight: '600', color: 'rgb(var(--foreground))', marginRight: '4px' },
  '.cm-lp-props-tag': { border: '1px solid rgb(var(--border))', borderRadius: '9999px', padding: '0 8px', lineHeight: '20px', backgroundColor: 'rgb(var(--card))' },
  '.cm-lp-props-more': { fontStyle: 'italic' },
  '.cm-lp-props:hover .cm-lp-props-tag': { borderColor: 'rgb(var(--primary) / 0.5)' },
  '.cm-lp-fm': { fontFamily: 'var(--font-mono)', fontSize: '0.8em', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-bullet': { color: 'rgb(var(--muted-foreground))', display: 'inline-block', width: '1.6em', textIndent: '0', textAlign: 'center' },
  '.cm-lp-number': { textAlign: 'right', paddingRight: '0.4em' },
  '.cm-lp-check': { margin: '0 0.6em 0 0.1em', verticalAlign: '-0.1em', accentColor: 'rgb(var(--primary))', cursor: 'pointer' },
  '.cm-lp-check:disabled': { cursor: 'default' },
  '.cm-lp-hr': { display: 'inline-block', width: '100%', borderTop: '1px solid rgb(var(--border))', verticalAlign: 'middle' },
  '.cm-lp-img': { maxWidth: '100%', borderRadius: 'var(--radius)', verticalAlign: 'top' },
  '.cm-lp-block': { cursor: 'pointer', margin: '0.4em 0', whiteSpace: 'normal', contain: 'inline-size' },
  '.cm-lp-mark': { backgroundColor: 'rgb(var(--primary) / 0.22)', borderRadius: '2px', padding: '0 0.15em' },
  '.cm-lp-alert': {
    color: 'rgb(var(--foreground))', borderStyle: 'solid', borderWidth: '0 1px 0 4px !important',
    paddingLeft: '1em !important', paddingRight: '1em !important',
  },
  '.cm-lp-alert.cm-lp-first': {
    borderTopWidth: '1px !important', borderTopLeftRadius: 'var(--radius)', borderTopRightRadius: 'var(--radius)', paddingTop: '0.7em !important',
  },
  '.cm-lp-alert.cm-lp-last': {
    borderBottomWidth: '1px !important', borderBottomLeftRadius: 'var(--radius)', borderBottomRightRadius: 'var(--radius)',
    paddingBottom: '0.7em !important',
  },
  '.cm-lp-alert-title': { fontWeight: '600' },
  '.cm-lp-alert-note': { borderColor: 'rgb(42 127 217 / 0.5) !important', backgroundColor: 'rgb(42 127 217 / 0.07)' },
  '.cm-lp-alert-tip': { borderColor: 'rgb(42 168 118 / 0.5) !important', backgroundColor: 'rgb(42 168 118 / 0.07)' },
  '.cm-lp-alert-important': { borderColor: 'rgb(166 42 217 / 0.45) !important', backgroundColor: 'rgb(166 42 217 / 0.06)' },
  '.cm-lp-alert-warning': { borderColor: 'rgb(196 154 0 / 0.55) !important', backgroundColor: 'rgb(196 154 0 / 0.08)' },
  '.cm-lp-alert-caution': { borderColor: 'rgb(var(--destructive) / 0.5) !important', backgroundColor: 'rgb(var(--destructive) / 0.07)' },
  '.cm-lp-mermaid': { textAlign: 'center', color: 'rgb(var(--muted-foreground))', fontSize: '0.85em' },
  '.cm-lp-mermaid svg': { margin: '0 auto', display: 'block' },
  '.cm-lp-table table': { margin: '0' },
  '.cm-lp-math': { textAlign: 'center' },
})

// Code inside fenced blocks takes the classes of the view's highlight.js colors. Markdown itself gets no style.
const liveHighlight = tagHighlighter([
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.modifier, tags.self], class: 'hljs-keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.attributeValue], class: 'hljs-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.typeName, tags.className, tags.standard(tags.variableName)], class: 'hljs-number' },
  { tag: [tags.lineComment, tags.blockComment, tags.docComment], class: 'hljs-comment' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.tagName], class: 'hljs-title' },
  { tag: [tags.propertyName, tags.attributeName], class: 'hljs-attr' },
  { tag: tags.deleted, class: 'hljs-deletion' },
  { tag: tags.inserted, class: 'hljs-addition' },
])

export function livePreview(): Extension {
  return [liveField, liveTheme, syntaxHighlighting(liveHighlight), EditorView.editorAttributes.of({ class: 'cm-live' })]
}
