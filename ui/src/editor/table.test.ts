import { describe, expect, it } from 'vitest'
import { ChangeSet, Text, type ChangeSpec } from '@codemirror/state'
import { addColumn, addRow, cellText, parseTable, removeColumn, removeRow, setAlign, setCell, tidy } from '@/editor/table'

const src = ['intro', '', '| Region | Revenue |', '|--------|--------:|', '| Europe | 1.2 \\| 3 |', '| Asia | 0.9', '', 'after'].join('\n')
const doc = Text.of(src.split('\n'))
const table = () => parseTable(doc, src.indexOf('| Region'))!

function apply(spec: ChangeSpec): string {
  return ChangeSet.of(spec, doc.length).apply(doc).toString()
}
const lines = (s: string) => s.split('\n').filter((l) => l.includes('|'))

describe('table model', () => {
  it('reads cells, escaped pipes, alignment and a missing trailing pipe', () => {
    const t = table()
    expect(t.header.cells.map((c) => c.text)).toEqual(['Region', 'Revenue'])
    expect(t.align).toEqual(['', 'right'])
    expect(t.body.map((r) => r.cells.map((c) => c.text))).toEqual([
      ['Europe', '1.2 \\| 3'],
      ['Asia', '0.9'],
    ])
    expect(cellText(t, 1, 1)).toBe('1.2 | 3')
    expect(doc.sliceString(t.from, t.to)).toBe(lines(src).join('\n'))
  })

  it('reads a table with a header only', () => {
    const d = Text.of(['| a | b |', '| - | - |'])
    const t = parseTable(d, 0)!
    expect(t.body).toEqual([])
    expect(t.to).toBe(d.length)
  })

  it('returns null without a delimiter row', () => {
    expect(parseTable(Text.of(['| a |', 'text']), 0)).toBeNull()
  })

  it('changes only the edited part of one cell and escapes pipes', () => {
    const out = apply(setCell(table(), 2, 0, 'Asia | Pacific'))
    expect(lines(out)[3]).toBe('| Asia \\| Pacific | 0.9')
    expect(lines(out).filter((l, i) => l !== lines(src)[i])).toHaveLength(1)
    const spec = setCell(table(), 1, 0, 'Europe West') as { from: number; to: number; insert: string }
    expect(spec.insert).toBe(' West')
    expect(spec.to - spec.from).toBe(0)
  })

  it('types into an empty cell and keeps a typed trailing space in the cell', () => {
    const d = Text.of(['| a | b |', '|---|---|', '|  | x |'])
    let doc2 = d
    const type = (row: number, col: number, text: string) => {
      doc2 = ChangeSet.of(setCell(parseTable(doc2, 0)!, row, col, text), doc2.length).apply(doc2)
    }
    type(1, 0, 'O')
    expect(doc2.line(3).text).toBe('| O | x |')
    type(1, 1, 'x ')
    type(1, 1, 'x y')
    expect(doc2.line(3).text).toBe('| O | x y |')
  })

  it('fills a missing cell at the end of a short row', () => {
    const out = apply(setCell(table(), 2, 1, '7'))
    expect(lines(out)[3]).toBe('| Asia | 7')
    const d = Text.of(['| a | b | c |', '|---|---|---|', '| 1 |'])
    const t = parseTable(d, 0)!
    expect(ChangeSet.of(setCell(t, 1, 2, 'x'), d.length).apply(d).line(3).text).toBe('| 1 |  | x |')
  })

  it('adds and removes rows', () => {
    expect(lines(apply(addRow(table(), 0)))[2]).toBe('|  |  |')
    expect(lines(apply(addRow(table(), 2)))).toHaveLength(5)
    expect(lines(apply(addRow(table(), 2)))[4]).toBe('|  |  |')
    expect(lines(apply(removeRow(table(), 1)!))).toEqual([lines(src)[0], lines(src)[1], lines(src)[3]])
    expect(removeRow(table(), 0)).toBeNull()
  })

  it('adds and removes columns', () => {
    const left = lines(apply(addColumn(table(), 0)))
    expect(left[0]).toBe('|  | Region | Revenue |')
    expect(left[1]).toBe('| --- |--------|--------:|')
    const right = lines(apply(addColumn(table(), 2)))
    expect(right[0]).toBe('| Region | Revenue |  |')
    expect(right[1]).toBe('|--------|--------:| --- |')
    expect(right[3]).toBe('| Asia | 0.9 |  |')
    const gone = lines(apply(removeColumn(table(), 1)!))
    expect(gone[0]).toBe('| Region |')
    expect(gone[2]).toBe('| Europe |')
    expect(lines(apply(removeColumn(table(), 0)!))[0]).toBe('| Revenue |')
  })

  it('sets the alignment of a column', () => {
    expect(lines(apply(setAlign(table(), 0, 'center')))[1]).toBe('|:---:|--------:|')
    expect(lines(apply(setAlign(table(), 1, '')))[1]).toBe('|--------|---|')
  })

  it('tidies the table with padded columns', () => {
    expect(lines(apply(tidy(table())))).toEqual([
      '| Region |  Revenue |',
      '| ------ | -------: |',
      '| Europe | 1.2 \\| 3 |',
      '| Asia   |      0.9 |',
    ])
  })
})
