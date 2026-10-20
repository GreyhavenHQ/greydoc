import { afterEach, describe, expect, it, vi } from 'vitest'
import { importFiles } from './importNotes'

function stubFetch() {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ alias: 'x' }), { status: 201 })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('importFiles', () => {
  it('sends Markdown as JSON with the folder', async () => {
    const calls = stubFetch()
    await importFiles([new File(['# Plan'], 'plan.md')], 'f1')
    expect(calls[0].url).toBe('/api/notes')
    expect(new Headers(calls[0].init.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ content: '# Plan', folder: 'f1' })
  })

  it('sends Markdown without a folder at the top level', async () => {
    const calls = stubFetch()
    await importFiles([new File(['# Plan'], 'plan.markdown')])
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ content: '# Plan' })
  })

  it('sends a zip with the folder and asks for a greydoc export', async () => {
    const calls = stubFetch()
    await importFiles([new File(['zip'], 'a.zip')], 'f1')
    expect(calls[0].url).toBe('/api/notes/import')
    const form = calls[0].init.body as FormData
    expect(form.get('folder')).toBe('f1')
    expect(form.get('require_meta')).toBe('1')
    expect(form.get('file')).toBeInstanceOf(File)
  })

  it('sends a zip without a folder field at the top level', async () => {
    const calls = stubFetch()
    await importFiles([new File(['zip'], 'a.zip')])
    const form = calls[0].init.body as FormData
    expect(form.has('folder')).toBe(false)
    expect(form.get('require_meta')).toBe('1')
  })
})
