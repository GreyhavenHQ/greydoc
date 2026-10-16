import { EditorSelection, Prec, type ChangeSpec, type EditorState, type Extension, type StateCommand, type Text, type Transaction } from '@codemirror/state'
import { keymap, type KeyBinding } from '@codemirror/view'

const userEvent = 'input.format'

function runLeft(doc: Text, pos: number, ch: string): number {
  let n = 0
  while (pos - n > 0 && doc.sliceString(pos - n - 1, pos - n) === ch) n++
  return n
}

function runRight(doc: Text, pos: number, ch: string): number {
  let n = 0
  while (pos + n < doc.length && doc.sliceString(pos + n, pos + n + 1) === ch) n++
  return n
}

// fits tells whether a run of marker characters closes this marker: * is a run of 1 or 3, ** a run of 2 or more.
function fits(marker: string, run: number): boolean {
  if (marker === '*' || marker === '~') return run === 1 || run === 3
  return run >= marker.length
}

function countRun(s: string, ch: string, fromEnd: boolean): number {
  let n = 0
  while (n < s.length && s[fromEnd ? s.length - 1 - n : n] === ch) n++
  return n
}

// toggleWrap wraps each selection range in marker, or removes marker when the range is already wrapped.
export function toggleWrap(marker: string): StateCommand {
  const n = marker.length
  const ch = marker[0]
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const tr = state.changeByRange((r) => {
      const doc = state.doc
      if (fits(marker, runLeft(doc, r.from, ch)) && fits(marker, runRight(doc, r.to, ch))) {
        return {
          changes: [
            { from: r.from - n, to: r.from },
            { from: r.to, to: r.to + n },
          ],
          range: EditorSelection.range(r.anchor - n, r.head - n),
        }
      }
      const text = state.sliceDoc(r.from, r.to)
      const lead = countRun(text, ch, false)
      if (text.length >= 2 * n && lead < text.length && fits(marker, lead) && fits(marker, countRun(text, ch, true))) {
        const back = r.anchor > r.head
        return {
          changes: [
            { from: r.from, to: r.from + n },
            { from: r.to - n, to: r.to },
          ],
          range: back ? EditorSelection.range(r.to - 2 * n, r.from) : EditorSelection.range(r.from, r.to - 2 * n),
        }
      }
      return {
        changes: [
          { from: r.from, insert: marker },
          { from: r.to, insert: marker },
        ],
        range: EditorSelection.range(r.anchor + n, r.head + n),
      }
    })
    dispatch(state.update(tr, { scrollIntoView: true, userEvent }))
    return true
  }
}

// touchedLines lists the lines under the selection. A range that ends at the start of a line leaves that line out.
function touchedLines(state: EditorState): number[] {
  const out = new Set<number>()
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number
    let last = state.doc.lineAt(r.to).number
    if (last > first && r.to === state.doc.line(last).from) last--
    for (let l = first; l <= last; l++) out.add(l)
  }
  return [...out].sort((a, b) => a - b)
}

function targetLines(state: EditorState): number[] {
  const all = touchedLines(state)
  const full = all.filter((l) => state.doc.line(l).text.trim() !== '')
  return full.length ? full : all
}

function applyLines(state: EditorState, dispatch: (tr: Transaction) => void, changes: ChangeSpec[]) {
  const set = state.changes(changes)
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => EditorSelection.range(set.mapPos(r.anchor, 1), set.mapPos(r.head, 1))),
    state.selection.mainIndex,
  )
  dispatch(state.update({ changes: set, selection, scrollIntoView: true, userEvent }))
}

export type ListKind = 'bullet' | 'ordered' | 'task'

const listPrefix = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] )?/
const isKind: Record<ListKind, RegExp> = {
  bullet: /^[-*+] $/,
  task: /^[-*+] \[[ xX]\] $/,
  ordered: /^\d+[.)] $/,
}

// toggleList puts a list prefix on every touched line, or removes it when all lines have it.
export function toggleList(kind: ListKind): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const lines = targetLines(state).map((l) => {
      const line = state.doc.line(l)
      const m = listPrefix.exec(line.text)!
      return { from: line.from + m[1].length, prefix: m[2] ?? '' }
    })
    const all = lines.every((l) => isKind[kind].test(l.prefix))
    const changes = lines.map((l, i) => {
      if (all) return { from: l.from, to: l.from + l.prefix.length }
      if (kind === 'task' && isKind.task.test(l.prefix)) return { from: l.from }
      const insert = kind === 'bullet' ? '- ' : kind === 'task' ? '- [ ] ' : `${i + 1}. `
      return { from: l.from, to: l.from + l.prefix.length, insert }
    })
    applyLines(state, dispatch, changes)
    return true
  }
}

const headingPrefix = /^ {0,3}(#{1,6})(?:[ \t]+|$)/

// setHeading makes every touched line a heading of level, or plain text for level 0 or when all lines have that level.
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const lines = targetLines(state).map((l) => {
      const line = state.doc.line(l)
      const m = headingPrefix.exec(line.text)
      return { from: line.from, len: m ? m[0].length : 0, level: m ? m[1].length : 0 }
    })
    const off = level === 0 || lines.every((l) => l.level === level)
    const insert = off ? '' : '#'.repeat(level) + ' '
    applyLines(
      state,
      dispatch,
      lines.map((l) => ({ from: l.from, to: l.from + l.len, insert })),
    )
    return true
  }
}

// insertLink turns each range into [text](url) with url selected, or a selected address into [](address).
export const insertLink: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false
  const tr = state.changeByRange((r) => {
    const text = state.sliceDoc(r.from, r.to)
    if (!text || /^https?:\/\/\S+$/.test(text)) {
      const insert = `[](${text || 'url'})`
      return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + 1) }
    }
    const url = r.from + text.length + 3
    return { changes: { from: r.from, to: r.to, insert: `[${text}](url)` }, range: EditorSelection.range(url, url + 3) }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent }))
  return true
}

// formatKeymap binds the formatting keys. It runs before the default keymap, which binds Mod-i to selectParentSyntax.
export function formatKeymap(opts: { onComment: () => void }): Extension {
  const bindings: KeyBinding[] = [
    { key: 'Mod-b', run: toggleWrap('**') },
    { key: 'Mod-i', run: toggleWrap('*') },
    { key: 'Mod-u', run: toggleWrap('++') },
    { key: 'Mod-Shift-x', run: toggleWrap('~~') },
    { key: 'Mod-Shift-h', run: toggleWrap('==') },
    { key: 'Mod-e', run: toggleWrap('`') },
    { key: 'Mod-.', run: toggleWrap('^') },
    { key: 'Mod-,', run: toggleWrap('~') },
    { key: 'Mod-k', run: insertLink },
    ...[0, 1, 2, 3, 4, 5, 6].map((n) => ({ key: `Mod-Alt-${n}`, run: setHeading(n) })),
    { key: 'Mod-Shift-7', run: toggleList('ordered') },
    { key: 'Mod-Shift-8', run: toggleList('bullet') },
    { key: 'Mod-Shift-9', run: toggleList('task') },
    {
      key: 'Mod-Alt-m',
      run: (view) => {
        if (view.state.selection.main.empty) return false
        opts.onComment()
        return true
      },
    },
    { key: 'Mod-s', run: () => true },
  ]
  return Prec.high(keymap.of(bindings))
}
