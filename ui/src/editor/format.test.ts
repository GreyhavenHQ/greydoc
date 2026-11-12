import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState, type StateCommand, type Transaction } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { formatState, insertBlock, insertFootnote, insertLink, linkAt, linkChange, linkInfoAt, setHeading, toggleList, toggleQuote, toggleWrap } from '@/editor/format'
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

describe('toggleQuote', () => {
  it('quotes and unquotes the touched lines', () => {
    expect(fmt(toggleQuote, 'a|')).toBe('> a|')
    expect(fmt(toggleQuote, '> a|')).toBe('a|')
    expect(fmt(toggleQuote, '«a\nb»')).toBe('> «a\n> b»')
    expect(fmt(toggleQuote, '«> a\n> b»')).toBe('«a\nb»')
  })
})

describe('insertBlock', () => {
  it('puts a block on an empty line with the cursor at the marker', () => {
    expect(fmt(insertBlock('```\n§\n```\n'), '|')).toBe('```\n|\n```\n')
  })
  it('adds no second blank line when one follows already', () => {
    expect(fmt(insertBlock('---\n§'), 'a|\n')).toBe('a\n\n---\n|\n')
    expect(fmt(insertBlock('```\n§\n```\n'), 'a|\n\nb')).toBe('a\n\n```\n|\n```\n\nb')
  })
  it('puts a block after a line of text, separated by a blank line', () => {
    expect(fmt(insertBlock('| § | Column 2 |\n| --- | --- |\n|  |  |\n'), 'te|xt\nnext')).toBe('text\n\n| | | Column 2 |\n| --- | --- |\n|  |  |\n\nnext')
  })
})

describe('formatState', () => {
  const at = (s: string) => {
    const state = EditorState.create({ ...parse(s), extensions: markdown({ base: markdownLanguage }) })
    ensureSyntaxTree(state, state.doc.length, 1000)
    return formatState(state)
  }
  it('reports the marks and the block at the cursor', () => {
    expect(at('a **bo|ld** b').bold).toBe(true)
    expect(at('a **bold** |b').bold).toBe(false)
    expect(at('a *it|al* b').italic).toBe(true)
    expect(at('a [li|nk](x) b').link).toBe(true)
    expect(at('## Ti|tle').block).toBe('h2')
    expect(at('Ti|tle').block).toBe('p')
    expect(at('- it|em').list).toBe('bullet')
    expect(at('1. it|em').list).toBe('ordered')
    expect(at('- [ ] it|em').list).toBe('task')
    expect(at('> quo|te').quote).toBe(true)
  })
})

describe('links', () => {
  const state = (s: string) => {
    const st = EditorState.create({ ...parse(s), extensions: markdown({ base: markdownLanguage }) })
    ensureSyntaxTree(st, st.doc.length, 1000)
    return st
  }
  const apply = (s: string, text: string, url: string) => {
    const st = state(s)
    const change = linkChange(st, text, url)
    return show(st.update(change).state)
  }

  it('reads the link at the cursor', () => {
    expect(linkAt(state('See the [Q4 re|view](https://example.com) now.'))).toEqual({ from: 8, to: 40, text: 'Q4 review', url: 'https://example.com', note: false, editable: true })
    expect(linkAt(state('See |the [Q4 review](https://example.com) now.'))).toBeNull()
  })

  it('changes the text and the address of a link', () => {
    expect(apply('See [Q4 re|view](https://example.com) now.', 'Q4 plan', 'https://example.org')).toBe('See [Q4 plan](https://example.org)| now.')
  })

  it('removes a link and keeps its text', () => {
    expect(apply('See [Q4 re|view](https://example.com) now.', 'Q4 review', '')).toBe('See Q4 review| now.')
  })

  it('makes a link of a selection or inserts one at the cursor', () => {
    expect(apply('See «this» now.', 'this', 'https://x.example')).toBe('See [this](https://x.example)| now.')
    expect(apply('See | now.', '', 'https://x.example')).toBe('See [https://x.example](https://x.example)| now.')
    expect(apply('See «a» now.', 'a', 'https://x.example/a (b)')).toBe('See [a](https://x.example/a%20%28b%29)| now.')
  })
})

describe('insertFootnote', () => {
  it('adds the next free number at the cursor and its note at the end', () => {
    expect(fmt(insertFootnote, 'A claim|.')).toBe('A claim[^1].\n\n[^1]: |')
    expect(fmt(insertFootnote, 'One[^1] two|.\n\n[^1]: First.\n')).toBe('One[^1] two[^2].\n\n[^1]: First.\n[^2]: |')
  })
})

describe('linkInfoAt', () => {
  const at = (doc: string, needle: string) => {
    const st = EditorState.create({ doc, extensions: markdown({ base: markdownLanguage }) })
    ensureSyntaxTree(st, st.doc.length, 1000)
    return linkInfoAt(st, doc.indexOf(needle) + 1)
  }
  it('finds the address of a link, a bare address and a link to a document', () => {
    expect(at('See [Q4 review](https://example.com).', 'review')).toEqual({ from: 4, to: 36, text: 'Q4 review', url: 'https://example.com', note: false, editable: true })
    expect(at('Go to https://x.example/a now', 'example')).toEqual({ from: 6, to: 25, text: 'https://x.example/a', url: 'https://x.example/a', note: false, editable: false })
    expect(at('Go to <https://x.example> now', 'example')).toEqual({ from: 6, to: 25, text: 'https://x.example', url: 'https://x.example', note: false, editable: false })
    expect(at('See [[zz-target|Target]] here', 'target')).toEqual({ from: 4, to: 24, text: 'Target', url: '/n/zz-target', note: true, editable: false })
    expect(at('See [[zz-target#Release plan|Plan]] here', 'Plan]')?.url).toBe('/n/zz-target#release-plan')
    expect(at('Plain text', 'text')).toBeNull()
  })
})
