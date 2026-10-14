import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { textRuns } from '@/editor/attribution'

describe('textRuns', () => {
  it('splits visible text by the client that inserted it', () => {
    const a = new Y.Doc()
    a.clientID = 1
    const b = new Y.Doc()
    b.clientID = 2
    a.getText('content').insert(0, 'hello world')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    b.getText('content').insert(5, ' brave')
    b.getText('content').delete(0, 1)
    b.getText('content').insert(0, 'H')
    const runs = textRuns(b.getText('content'))
    expect(b.getText('content').toString()).toBe('Hello brave world')
    expect(runs).toEqual([
      { from: 0, to: 1, client: 2 },
      { from: 1, to: 5, client: 1 },
      { from: 5, to: 11, client: 2 },
      { from: 11, to: 17, client: 1 },
    ])
  })
})
