import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

// In the document style, typed text reads as typed: the characters that would start Markdown are stored escaped.
// Formatting comes from the toolbar and the keys, never from what a person types.

const always = new Set(['\\', '*', '_', '`', '[', ']', '<', '~', '^', '$', '|', '&'])
// lineStart matches what may come before the text of a line: spaces, list markers, a task box, quote marks.
const lineStart = /^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>\s?)*$/

// escapeTyped gives what to insert for one typed character, given the text of the line before the cursor.
export function escapeTyped(before: string, ch: string): string {
  const prev = before.slice(-1)
  const atStart = lineStart.test(before)
  const escape =
    always.has(ch) ||
    ((ch === '=' || ch === '+') && (prev === ch || atStart)) ||
    ((ch === '#' || ch === '-' || ch === '>') && atStart) ||
    ((ch === '.' || ch === ')') && lineStart.test(before.replace(/\d+$/, '')) && /\d$/.test(before)) ||
    (ch === ':' && (atStart || /:[a-z0-9_+-]+$/i.test(before)))
  return escape ? '\\' + ch : ch
}


const rawBlocks = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'Table'])

// rawContext says whether pos is in source that people edit as such: code, a formula, front matter, an HTML block,
// or a table shown as Markdown. There a typed character is not escaped.
export function rawContext(state: EditorState, pos: number): boolean {
  const doc = state.doc
  for (let n: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (rawBlocks.has(n.name) || (n.name === 'InlineCode' && pos > n.from && pos < n.to)) return true
  }
  const line = doc.lineAt(pos)
  for (const m of line.text.matchAll(/(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g)) {
    if (pos > line.from + m.index! && pos < line.from + m.index! + m[0].length) return true
  }
  let math = false
  let front = doc.lines > 1 && /^-{3,}$/.test(doc.line(1).text)
  for (let n = 1; n < line.number; n++) {
    const t = doc.line(n).text
    if (front && n > 1 && /^(?:-{3,}|\.{3,})$/.test(t)) front = false
    else if (!front && t.trim() === '$$') math = !math
  }
  return front || math || line.text.trim() === '$$'
}
