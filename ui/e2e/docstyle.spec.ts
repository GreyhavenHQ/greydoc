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
