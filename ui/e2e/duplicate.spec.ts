import { expect, test } from '@playwright/test'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('the document menu duplicates the document with its images', async ({ page }) => {
  await page.request.post('/api/notes', { data: { content: '# Holder\n', alias: 'dup-holder' } })
  const up = await page.request.post('/api/notes/dup-holder/media', { multipart: { file: { name: 'a.png', mimeType: 'image/png', buffer: png } } })
  const { url } = await up.json()
  await page.request.post('/api/notes', { data: { content: `# Dup plan\n\n![shot](${url})\n`, alias: 'dup-source' } })

  await page.goto('/n/dup-source')
  await expect(page.getByTestId('preview').locator('h1')).toHaveText('Dup plan')
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Duplicate this document' }).click()
  await expect(page).not.toHaveURL(/\/n\/dup-source$/)
  await expect(page.getByTestId('preview').locator('h1')).toHaveText('Copy of Dup plan')
  const img = page.getByTestId('preview').locator('img')
  await expect(img).toHaveAttribute('src', /\/uploads\/[0-9a-f]{32}\.png/)
  await expect(img).not.toHaveAttribute('src', new RegExp(url))
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1)
})

test('the index row menu duplicates a document into its folder', async ({ page }) => {
  const r = await page.request.post('/api/folders', { data: { name: 'Dup folder' } })
  const id = (await r.json()).folder.id
  await page.request.post('/api/notes', { data: { content: '# Dup row', alias: 'dup-row', folder: id } })
  await page.goto('/f/' + id)
  await page.getByTestId('note-list').locator('li', { hasText: 'Dup row' }).click({ button: 'right' })
  await page.getByTestId('item-menu').getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(page.getByText('Duplicated', { exact: true })).toBeVisible()
  await expect(page.getByTestId('preview').locator('h1')).toHaveText('Copy of Dup row')
  await page.goBack()
  await expect(page.getByTestId('note-list').locator('li')).toHaveCount(2)
  await expect(page.getByTestId('note-list')).toContainText('Copy of Dup row')
})

test('a signed-out reader cannot duplicate', async ({ browser }) => {
  // The greydoc with OIDC that e2e/fake-idp.mjs starts.
  const base = 'http://127.0.0.1:3996'
  const owner = await (await browser.newContext({ baseURL: base })).newPage()
  await owner.goto('http://127.0.0.1:3997/as/alice')
  await owner.goto('/auth/login?next=/')
  const alias = (await (await owner.request.post('/api/notes', { data: { content: '# Public dup' } })).json()).alias
  await owner.request.put(`/api/notes/${alias}/permissions/groups/_everyone`, { data: { level: 'read' } })

  const guest = await (await browser.newContext({ baseURL: base })).newPage()
  await guest.goto('/n/' + alias)
  await expect(guest.getByTestId('preview').locator('h1')).toHaveText('Public dup')
  await guest.getByRole('button', { name: 'More' }).click()
  await expect(guest.getByRole('menuitem', { name: 'Timeline' })).toBeVisible()
  await expect(guest.getByRole('menuitem', { name: 'Duplicate this document' })).toHaveCount(0)
  expect((await guest.request.post(`/api/notes/${alias}/duplicate`)).status()).toBe(401)
})
