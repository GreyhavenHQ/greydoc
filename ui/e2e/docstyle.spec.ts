import { expect, test } from '@playwright/test'
import { sample } from './sample'

// The server runs in local mode, so these preferences belong to the one local user. They are reset after each test.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('greydoc-mode', 'live'))
  expect((await page.request.patch('/api/me/prefs', { data: { live_style: 'document' } })).status()).toBe(200)
})
test.afterEach(async ({ request }) => {
  await request.patch('/api/me/prefs', { data: { live_style: '' } })
})

test('the document style never shows Markdown marks', async ({ page }) => {
  const alias = (await (await page.request.post('/api/notes', { data: { content: sample } })).json()).alias
  await page.goto('/n/' + alias)
  const editor = page.getByTestId('editor')
  const line = editor.locator('.cm-line', { hasText: 'This document collects' })
  await editor.locator('.cm-lp-strong', { hasText: 'numbers' }).dblclick()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(line).not.toContainText('*')
  await page.keyboard.type('Z')
  await expect(line).toContainText('the Znumbers')
  await expect(line).not.toContainText('*')
  await expect.poll(async () => (await page.request.get(`/api/notes/${alias}/download.md`)).text()).toContain('the Z**numbers**')

  await editor.locator('.cm-lp-h1').click()
  await expect(editor.locator('.cm-lp-h1')).toHaveText('Quarterly review')
  await editor.locator('.cm-lp-link').click()
  await expect(line).not.toContainText('https://example.com')
})

test('edit the text and address of a link without Markdown', async ({ page }) => {
  const alias = (await (await page.request.post('/api/notes', { data: { content: sample } })).json()).alias
  await page.goto('/n/' + alias)
  const editor = page.getByTestId('editor')
  const line = editor.locator('.cm-line', { hasText: 'This document collects' })
  await editor.locator('.cm-lp-link').click()
  await page.getByTestId('format-toolbar').getByRole('button', { name: /^Link/ }).click()
  const pop = page.getByTestId('link-popover')
  await expect(pop.getByLabel('Text')).toHaveValue('Q4 review')
  await expect(pop.getByLabel('Address')).toHaveValue('https://example.com')
  await pop.getByLabel('Text').fill('Q4 plan')
  await pop.getByLabel('Address').fill('https://example.org')
  await pop.getByLabel('Address').press('Enter')
  await expect(pop).toHaveCount(0)
  await expect.poll(async () => (await page.request.get(`/api/notes/${alias}/download.md`)).text()).toContain('for the [Q4 plan](https://example.org).')
  await expect(line).not.toContainText('https://')

  await editor.locator('.cm-lp-link').click()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(pop.getByLabel('Address')).toHaveValue('https://example.org')
  await pop.getByRole('button', { name: 'Remove link' }).click()
  await expect.poll(async () => (await page.request.get(`/api/notes/${alias}/download.md`)).text()).toContain('for the Q4 plan.')
})
