import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState, type StateCommand, type Transaction } from '@codemirror/state'
import { insertLink, setHeading, toggleList, toggleWrap } from '@/editor/format'
import { captureEdits, type PendingEdit } from '@/editor/suggestions'

// Text notation: | is a cursor, « and » are the anchor and the head of a selection.
function parse(s: string) {
  const ranges = []
  let doc = ''
  let anchor = -1
  let head = -1
  for (const c of s) {
    if (c === '|') ranges.push(EditorSelection.cursor(doc.length))
    else if (c === '«') anchor = doc.length
    else if (c === '»') head = doc.length
    else doc += c
    if (anchor >= 0 && head >= 0) {
      ranges.push(EditorSelection.range(anchor, head))
      anchor = head = -1
    }
  }
  return { doc, selection: EditorSelection.create(ranges) }
}

function show(state: EditorState): string {
  const marks: [number, string][] = []
  for (const r of state.selection.ranges) {
    if (r.empty) marks.push([r.head, '|'])
    else marks.push([r.anchor, '«'], [r.head, '»'])
  }
  let out = state.doc.toString()
  for (const [pos, m] of marks.sort((a, b) => b[0] - a[0] || (a[1] === '«' ? 1 : -1))) out = out.slice(0, pos) + m + out.slice(pos)
  return out
}

function run(cmd: StateCommand, s: string, extra: Parameters<typeof EditorState.create>[0] = {}): { text: string; tr: Transaction | null } {
  const state = EditorState.create({ ...parse(s), extensions: [EditorState.allowMultipleSelections.of(true), extra.extensions ?? []] })
  let tr: Transaction | null = null
  const ok = cmd({ state, dispatch: (t) => (tr = t) })
  return { text: ok && tr ? show((tr as Transaction).state) : show(state), tr }
}

const fmt = (cmd: StateCommand, s: string) => run(cmd, s).text

describe('toggleWrap', () => {
  it('wraps and unwraps a selection', () => {
    expect(fmt(toggleWrap('**'), 'a «word» b')).toBe('a **«word»** b')
    expect(fmt(toggleWrap('**'), 'a **«word»** b')).toBe('a «word» b')
    expect(fmt(toggleWrap('**'), 'a «**word**» b')).toBe('a «word» b')
  })
  it('inserts a pair at a cursor and removes an empty pair', () => {
    expect(fmt(toggleWrap('**'), 'a |b')).toBe('a **|**b')
    expect(fmt(toggleWrap('**'), 'a **|**b')).toBe('a |b')
  })
  it('tells italic from bold', () => {
    expect(fmt(toggleWrap('*'), '**«word»**')).toBe('***«word»***')
    expect(fmt(toggleWrap('*'), '***«word»***')).toBe('**«word»**')
    expect(fmt(toggleWrap('*'), '*«word»*')).toBe('«word»')
    expect(fmt(toggleWrap('**'), '*«word»*')).toBe('***«word»***')
    expect(fmt(toggleWrap('~'), '~~«word»~~')).toBe('~~~«word»~~~')
  })
  it('keeps a backward selection backward', () => {
    expect(fmt(toggleWrap('`'), 'x »code« y')).toBe('x `»code«` y')
    expect(fmt(toggleWrap('`'), 'x »`code`« y')).toBe('x »code« y')
  })
  it('formats every range', () => {
    expect(fmt(toggleWrap('=='), '«a» and «b»')).toBe('==«a»== and ==«b»==')
  })
  it('does nothing in a read-only editor', () => {
    const r = run(toggleWrap('**'), '«a»', { extensions: EditorState.readOnly.of(true) })
    expect(r.tr).toBeNull()
  })
  it('is one transaction marked as a format input', () => {
    const r = run(toggleWrap('**'), '«a» «b»')
    expect(r.tr!.isUserEvent('input.format')).toBe(true)
  })
  it('becomes a suggestion for a commenter and leaves the text alone', () => {
    let got: PendingEdit | null = null
    const r = run(toggleWrap('**'), 'The plan is «bad».', { extensions: captureEdits(() => true, (e) => (got = e)) })
    expect(r.tr!.state.doc.toString()).toBe('The plan is bad.')
    expect(got).toEqual({ from: 12, to: 15, original: 'bad', proposed: '**bad**' })
  })
})

describe('setHeading', () => {
  it('sets, changes and removes a heading', () => {
    expect(fmt(setHeading(2), 'Pl|an')).toBe('## Pl|an')
    expect(fmt(setHeading(3), '## Pl|an')).toBe('### Pl|an')
    expect(fmt(setHeading(2), '## Pl|an')).toBe('Pl|an')
    expect(fmt(setHeading(0), '### Pl|an')).toBe('Pl|an')
  })
  it('puts the cursor after the new prefix', () => {
    expect(fmt(setHeading(1), '|Plan')).toBe('# |Plan')
  })
  it('applies to every non-empty touched line', () => {
    expect(fmt(setHeading(1), '«a\n\nb»')).toBe('# «a\n\n# b»')
  })
})

describe('toggleList', () => {
  it('adds and removes bullets on touched lines', () => {
    expect(fmt(toggleList('bullet'), '«a\nb\nc»')).toBe('- «a\n- b\n- c»')
    expect(fmt(toggleList('bullet'), '- «a\n- b\n- c»')).toBe('«a\nb\nc»')
  })
  it('leaves out a line where the selection only starts', () => {
    expect(fmt(toggleList('bullet'), '«a\n»b')).toBe('- «a\n»b')
  })
  it('numbers from 1 and replaces other list prefixes', () => {
    expect(fmt(toggleList('ordered'), '«- a\n* b\n\nc»')).toBe('«1. a\n2. b\n\n3. c»')
  })
  it('makes a task list and keeps checked tasks', () => {
    expect(fmt(toggleList('task'), '«- [x] a\nb»')).toBe('«- [x] a\n- [ ] b»')
    expect(fmt(toggleList('task'), '«- [x] a\n- [ ] b»')).toBe('«a\nb»')
  })
  it('keeps indentation', () => {
    expect(fmt(toggleList('bullet'), '  |a')).toBe('  - |a')
  })
  it('adds a prefix on an empty line', () => {
    expect(fmt(toggleList('bullet'), 'a\n|')).toBe('a\n- |')
  })
})

describe('insertLink', () => {
  it('links the selected text and selects the address', () => {
    expect(fmt(insertLink, 'see «docs» now')).toBe('see [docs](«url») now')
  })
  it('puts a selected address in the parentheses', () => {
    expect(fmt(insertLink, '«https://x.example»')).toBe('[|](https://x.example)')
  })
  it('inserts an empty link at a cursor', () => {
    expect(fmt(insertLink, 'a |b')).toBe('a [|](url)b')
  })
})
