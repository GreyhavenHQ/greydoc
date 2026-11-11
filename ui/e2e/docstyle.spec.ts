import { expect, test } from '@playwright/test'
import { startWith } from './prefs'
import { sample } from './sample'

startWith({ default_mode: 'live', live_style: 'document' })

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

test('a grid cell is edited as rendered text in the document style', async ({ page }) => {
  const content = '| Region | Owner |\n|---|---|\n| **Asia** | Chen |\n'
  const alias = (await (await page.request.post('/api/notes', { data: { content } })).json()).alias
  await page.goto('/n/' + alias)
  const cell = page.getByTestId('editor').locator('.cm-lp-grid td').filter({ hasText: 'Asia' })
  await cell.click()
  await expect(cell).toBeFocused()
  await expect(cell).toHaveText('Asia')
  await expect(cell.locator('strong')).toHaveText('Asia')
  await page.keyboard.press('End')
  await page.keyboard.type(' Pacific')
  await expect.poll(async () => (await page.request.get(`/api/notes/${alias}/download.md`)).text()).toContain('| **Asia Pacific** | Chen |')

  const owner = page.getByTestId('editor').locator('.cm-lp-grid td').filter({ hasText: 'Chen' })
  await owner.dblclick()
  await page.getByTestId('format-toolbar').getByRole('button', { name: /^Italic/ }).click()
  await expect(owner).toHaveText('Chen')
  await expect(owner.locator('em')).toHaveText('Chen')
  await expect.poll(async () => (await page.request.get(`/api/notes/${alias}/download.md`)).text()).toContain('| **Asia Pacific** | *Chen* |')
})
