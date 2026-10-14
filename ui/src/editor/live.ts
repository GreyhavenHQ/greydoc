import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import katex from 'katex'
import { renderMarkdown } from '@/render/markdown'
import { renderMermaid, themeMode } from '@/render/mermaid'

// Live preview: Markdown that renders in place, like Obsidian. Lines and blocks under a selection show their source.

const hide = Decoration.replace({})

function revealAt(view: EditorView, dom: HTMLElement) {
  const pos = view.posAtDOM(dom)
  view.dispatch({ selection: { anchor: pos } })
  view.focus()
}

class MermaidWidget extends WidgetType {
  constructor(readonly src: string) {
    super()
  }
  eq(o: MermaidWidget) {
    return o.src === this.src
  }
  get estimatedHeight() {
    return 240
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div')
    el.className = 'cm-lp-block cm-lp-mermaid'
    el.textContent = 'Rendering diagram…'
    void renderMermaid(this.src, themeMode()).then((svg) => {
      el.innerHTML = svg
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
  eq() {
    return true
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-lp-bullet'
    el.textContent = '•'
    return el
  }
}

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
    box.onmousedown = (e) => e.preventDefault()
    box.onclick = (e) => {
      e.preventDefault()
      if (view.state.readOnly) return
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
  const lineClass = (from: number, to: number, cls: string) => {
    for (let pos = from; pos <= to; ) {
      const l = doc.lineAt(pos)
      out.push(Decoration.line({ class: cls }).range(l.from))
      pos = l.to + 1
    }
  }
  const code: [number, number][] = []

  const fmEnd = frontMatterEnd(state)
  if (fmEnd > 0) lineClass(0, fmEnd, 'cm-lp-fm')

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
          const alert = /^>\s*\[!(note|tip|important|warning|caution)\]/i.exec(doc.lineAt(node.from).text)
          lineClass(node.from, node.to, 'cm-lp-quote' + (alert ? ' cm-lp-alert cm-lp-alert-' + alert[1].toLowerCase() : ''))
          return
        }
        case 'QuoteMark':
          if (!lineActive(node.from)) {
            const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
            out.push(hide.range(node.from, end))
          }
          return
        case 'ListMark': {
          const mark = doc.sliceString(node.from, node.to)
          const task = node.node.nextSibling?.name === 'Task'
          if (lineActive(node.from)) return
          if (task) {
            out.push(hide.range(node.from, Math.min(node.to + 1, doc.lineAt(node.from).to)))
          } else if (/^[-*+]$/.test(mark)) {
            out.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to))
          }
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
            out.push(Decoration.replace({ widget: new MermaidWidget(src), block: true }).range(node.from, node.to))
            return false
          }
          lineClass(node.from, node.to, 'cm-lp-codeblock')
          for (const m of node.node.getChildren('CodeMark')) lineClass(m.from, m.from, 'cm-lp-fence')
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

const liveField = StateField.define<DecorationSet>({
  create: (state) => liveDecorations(state),
  update(deco, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return liveDecorations(tr.state)
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

const liveTheme = EditorView.theme({
  '&.cm-live .cm-scroller': { fontFamily: 'var(--font-sans)', lineHeight: '1.7' },
  '&.cm-live .cm-content': { maxWidth: '48rem', margin: '0 auto', padding: '40px 32px 30vh', fontSize: '16px' },
  '&.cm-live .cm-line': { padding: '0' },
  '.cm-lp-h': { fontWeight: '650', lineHeight: '1.3' },
  '.cm-lp-h1': { fontSize: '2em', paddingTop: '0.6em !important', letterSpacing: '-0.01em' },
  '.cm-lp-h2': { fontSize: '1.5em', paddingTop: '0.5em !important' },
  '.cm-lp-h3': { fontSize: '1.25em', paddingTop: '0.4em !important' },
  '.cm-lp-h4, .cm-lp-h5, .cm-lp-h6': { fontSize: '1.05em' },
  '.cm-lp-em': { fontStyle: 'italic' },
  '.cm-lp-strong': { fontWeight: '700' },
  '.cm-lp-strike': { textDecoration: 'line-through' },
  '.cm-lp-done': { textDecoration: 'line-through', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-code': {
    fontFamily: 'var(--font-mono)', fontSize: '0.875em', backgroundColor: 'rgb(var(--muted))', borderRadius: '4px', padding: '0.1em 0.3em',
  },
  '.cm-lp-link': { color: 'rgb(var(--primary))', textDecoration: 'underline', textUnderlineOffset: '2px' },
  '.cm-lp-quote': { borderLeft: '3px solid rgb(var(--border))', paddingLeft: '0.9em !important', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-codeblock': { fontFamily: 'var(--font-mono)', fontSize: '0.85em', backgroundColor: 'rgb(var(--muted))', padding: '0 0.9em !important' },
  '.cm-lp-fence': { color: 'rgb(var(--muted-foreground) / 0.7)' },
  '.cm-lp-table-src': { fontFamily: 'var(--font-mono)', fontSize: '0.85em' },
  '.cm-lp-fm': { fontFamily: 'var(--font-mono)', fontSize: '0.8em', color: 'rgb(var(--muted-foreground))' },
  '.cm-lp-bullet': { color: 'rgb(var(--muted-foreground))', display: 'inline-block', width: '0.9em' },
  '.cm-lp-check': { margin: '0 0.45em 0 0', verticalAlign: '-0.1em', accentColor: 'rgb(var(--primary))', cursor: 'pointer' },
  '.cm-lp-hr': { display: 'inline-block', width: '100%', borderTop: '1px solid rgb(var(--border))', verticalAlign: 'middle' },
  '.cm-lp-img': { maxWidth: '100%', borderRadius: 'var(--radius)', verticalAlign: 'top' },
  '.cm-lp-block': { cursor: 'pointer', margin: '0.4em 0', whiteSpace: 'normal' },
  '.cm-lp-mark': { backgroundColor: 'rgb(var(--primary) / 0.22)', borderRadius: '2px' },
  '.cm-lp-alert': { fontStyle: 'normal', color: 'rgb(var(--foreground))', borderLeftWidth: '4px !important' },
  '.cm-lp-alert-note': { borderLeftColor: 'rgb(42 127 217 / 0.7) !important', backgroundColor: 'rgb(42 127 217 / 0.07)' },
  '.cm-lp-alert-tip': { borderLeftColor: 'rgb(42 168 118 / 0.7) !important', backgroundColor: 'rgb(42 168 118 / 0.07)' },
  '.cm-lp-alert-important': { borderLeftColor: 'rgb(166 42 217 / 0.6) !important', backgroundColor: 'rgb(166 42 217 / 0.06)' },
  '.cm-lp-alert-warning': { borderLeftColor: 'rgb(196 154 0 / 0.7) !important', backgroundColor: 'rgb(196 154 0 / 0.08)' },
  '.cm-lp-alert-caution': { borderLeftColor: 'rgb(var(--destructive) / 0.7) !important', backgroundColor: 'rgb(var(--destructive) / 0.07)' },
  '.cm-lp-mermaid': { textAlign: 'center', color: 'rgb(var(--muted-foreground))', fontSize: '0.85em' },
  '.cm-lp-mermaid svg': { maxWidth: '100%', height: 'auto' },
  '.cm-lp-table table': { margin: '0' },
  '.cm-lp-math': { textAlign: 'center' },
})

export function livePreview(): Extension {
  return [liveField, liveTheme, EditorView.editorAttributes.of({ class: 'cm-live' })]
}
