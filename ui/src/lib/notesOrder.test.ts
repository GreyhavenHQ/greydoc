import { describe, expect, it } from 'vitest'
import type { NoteSummary } from '@/lib/api'
import { placeAfterPin } from './notesOrder'

const note = (id: string, title: string, updated: string, pinned = false, visited?: string): NoteSummary => ({
  id,
  alias: id,
  title,
  description: '',
  tags: [],
  owner: '',
  owner_id: '',
  updated_at: `2024-01-${updated}T00:00:00Z`,
  visited_at: visited && `2024-02-${visited}T00:00:00Z`,
  pinned,
  view_count: 0,
  slides: false,
})
const ids = (ns: NoteSummary[]) => ns.map((n) => n.id + (n.pinned ? '*' : ''))

describe('placeAfterPin', () => {
  const list = [note('z', 'Zeta', '01', true), note('m', 'Mid', '04'), note('a', 'alpha', '02'), note('o', 'Old', '01')]

  it('moves a pinned note to its place by name, case-insensitive', () => {
    expect(ids(placeAfterPin(list, 'a', true, 'index', false))).toEqual(['a*', 'z*', 'm', 'o'])
  })

  it('sorts an empty title as Untitled', () => {
    const ns = [note('t', 'Tango', '03', true), note('z', 'Zeta', '01', true), note('e', '', '02')]
    expect(ids(placeAfterPin(ns, 'e', true, 'index', false))).toEqual(['t*', 'e*', 'z*'])
  })

  it('moves an unpinned note to its place by last change', () => {
    const ns = [note('a', 'alpha', '02', true), note('z', 'Zeta', '01', true), note('m', 'Mid', '04'), note('o', 'Old', '01')]
    expect(ids(placeAfterPin(ns, 'a', false, 'index', false))).toEqual(['z*', 'm', 'a', 'o'])
  })

  it('breaks a tie on last change by id', () => {
    expect(ids(placeAfterPin(list, 'z', false, 'index', false))).toEqual(['m', 'a', 'o', 'z'])
  })

  it('drops a note placed after the last loaded row when more pages remain', () => {
    const ns = [note('z', 'Zeta', '01', true), note('m', 'Mid', '04'), note('a', 'alpha', '02')]
    expect(ids(placeAfterPin(ns, 'z', false, 'index', true))).toEqual(['m', 'a'])
    expect(ids(placeAfterPin(ns, 'z', false, 'index', false))).toEqual(['m', 'a', 'z'])
  })

  it('orders the recent tab by pin, then last visit', () => {
    const ns = [note('a', 'alpha', '01', true, '01'), note('b', 'Beta', '01', false, '05'), note('c', 'Gamma', '01', false, '03')]
    expect(ids(placeAfterPin(ns, 'c', true, 'recent', false))).toEqual(['c*', 'a*', 'b'])
    expect(ids(placeAfterPin(ns, 'a', false, 'recent', false))).toEqual(['b', 'c', 'a'])
  })

  it('only flips the flag in search results', () => {
    expect(ids(placeAfterPin(list, 'o', true, 'search', true))).toEqual(['z*', 'm', 'a', 'o*'])
  })
})
