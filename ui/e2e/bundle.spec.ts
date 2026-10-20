import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'

type DropFile = { name: string; type: string; base64: string }

const md = (name: string, text: string): DropFile => ({ name, type: 'text/markdown', base64: Buffer.from(text).toString('base64') })

async function dragOver(page: Page, files: DropFile[], target: Locator = page.locator('main')) {
  const dt = await page.evaluateHandle((list) => {
    const dt = new DataTransfer()
    for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name, { type: f.type }))
    return dt
  }, files)
  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  return { drop: () => target.dispatchEvent('drop', { dataTransfer: dt }) }
}

async function dropFiles(page: Page, files: DropFile[], target?: Locator) {
  const drag = await dragOver(page, files, target)
  await expect(page.getByTestId('drop-overlay')).toBeVisible()
  await drag.drop()
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
}

// storedZip builds a zip without compression, so that a test can send a zip that greydoc did not export.
function storedZip(files: Record<string, string>): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const fname = Buffer.from(name)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt32LE(crc32(data), 14)
    head.writeUInt32LE(data.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(fname.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt32LE(crc32(data), 16)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(fname.length, 28)
    dir.writeUInt32LE(offset, 42)
    locals.push(head, fname, data)
    central.push(dir, fname)
    offset += head.length + fname.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

async function newFolder(page: Page, name: string): Promise<string> {
  const r = await page.request.post('/api/folders', { data: { name } })
  return (await r.json()).folder.id
}

test('dropping a greydoc zip or a Markdown file on My documents imports it at the top level', async ({ page }) => {
  await page.request.post('/api/notes', { data: { content: '# Bundled note\n\nbody', alias: 'bundle-e2e' } })
  const zip = await (await page.request.get('/api/notes/bundle-e2e/export.zip')).body()

  await page.goto('/')
  await expect(page.getByTestId('note-list')).toContainText('Bundled note')
  await dropFiles(page, [{ name: 'bundled-note.zip', type: 'application/zip', base64: zip.toString('base64') }, md('from-disk.md', '# From a Markdown file\n')])
  await expect(page.getByText(/Imported “Bundled note” at \/[a-z0-9]+\. Its old address is taken here\./)).toBeVisible()
  await expect(page.getByText('Imported “From a Markdown file”')).toBeVisible()
  await expect(page.getByTestId('note-list').locator('li', { hasText: 'Bundled note' })).toHaveCount(2)
  await expect(page.getByTestId('note-list')).toContainText('From a Markdown file')
})

test('a Markdown file or a zip dropped on a folder page lands in that folder', async ({ page }) => {
  await page.request.post('/api/notes', { data: { content: '# Zipped into a folder\n', alias: 'zip-into-folder' } })
  const zip = await (await page.request.get('/api/notes/zip-into-folder/export.zip')).body()
  const id = await newFolder(page, 'Drop page')

  await page.goto('/f/' + id)
  await expect(page.getByTestId('breadcrumb')).toContainText('Drop page')
  const drag = await dragOver(page, [md('plan.md', '# Dropped plan\n')])
  await expect(page.getByTestId('drop-overlay')).toContainText('Drop into Drop page')
  await drag.drop()
  await expect(page.getByText('Imported “Dropped plan”')).toBeVisible()
  await expect(page.getByTestId('note-list')).toContainText('Dropped plan')

  await dropFiles(page, [{ name: 'z.zip', type: 'application/zip', base64: zip.toString('base64') }])
  await expect(page.getByText(/Imported “Zipped into a folder”/)).toBeVisible()
  await expect(page.getByTestId('note-list')).toContainText('Zipped into a folder')
})

test('a file dropped on a folder row lands in that folder, once', async ({ page }) => {
  const id = await newFolder(page, 'Row target')
  await page.goto('/')
  const row = page.getByTestId('folder-list').locator('li', { hasText: 'Row target' })
  await expect(row).toContainText('empty')
  const drag = await dragOver(page, [md('notes.md', '# Dropped on a row\n')], row)
  await expect(row).toHaveAttribute('data-drop-target', 'true')
  await expect(page.getByTestId('drop-overlay')).toContainText('Drop into Row target')
  await drag.drop()
  await expect(page.getByText('Imported “Dropped on a row”')).toBeVisible()
  await expect(row).toContainText('1 item')
  await expect(page.getByTestId('note-list')).not.toContainText('Dropped on a row')
  const all = await (await page.request.get('/api/notes?scope=all&q=Dropped%20on%20a%20row')).json()
  expect(all.notes.map((n: { folder_id?: string }) => n.folder_id)).toEqual([id])
})

test('a zip that is not a greydoc export is refused', async ({ page }) => {
  await page.goto('/')
  const plain = storedZip({ 'a.md': '# Not a greydoc zip\n' })
  await dropFiles(page, [{ name: 'plain.zip', type: 'application/zip', base64: plain.toString('base64') }])
  await expect(page.getByText(/plain\.zip: the zip is not a greydoc export/)).toBeVisible()
  const all = await (await page.request.get('/api/notes?scope=all&q=Not%20a%20greydoc')).json()
  expect(all.notes).toEqual([])
})

test('Recent does not take drops', async ({ page }) => {
  await page.goto('/?scope=recent')
  await expect(page.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true')
  const drag = await dragOver(page, [md('recent.md', '# Dropped on recent\n')])
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  await drag.drop()
  await page.waitForTimeout(300)
  const all = await (await page.request.get('/api/notes?scope=all&q=Dropped%20on%20recent')).json()
  expect(all.notes).toEqual([])
})

// The greydoc with OIDC that e2e/fake-idp.mjs starts.
const oidc = 'http://127.0.0.1:3996'

async function signIn(browser: Browser, user: string): Promise<Page> {
  const page = await (await browser.newContext({ baseURL: oidc })).newPage()
  await page.goto('http://127.0.0.1:3997/as/' + user)
  await page.goto('/auth/login?next=/')
  await expect(page).toHaveURL(oidc + '/')
  return page
}

test('a drop on a folder that you can only read is refused', async ({ browser }) => {
  const alice = await signIn(browser, 'alice')
  const bob = await signIn(browser, 'bob')
  const id = await newFolder(alice, 'Read only drop')
  await alice.request.put(`/api/folders/${id}/permissions/users/bob`, { data: { level: 'read' } })

  await bob.goto('/f/' + id)
  await expect(bob.getByTestId('breadcrumb')).toContainText('Read only drop')
  await dropFiles(bob, [md('bob.md', '# Bob tries\n')])
  await expect(bob.getByText('You cannot add documents to this folder.')).toBeVisible()
  const list = await (await alice.request.get(`/api/notes?scope=all&folder=${id}`)).json()
  expect(list.notes).toEqual([])
})
