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

test('boxes, callouts, definitions and collapsible sections are edited in place', async ({ page }) => {
  const content = ':::info\nAlso success.\n:::\n\n> [!NOTE]\n> Good to know.\n\nTerm\n: What it means.\n\n:::spoiler Click to open\nHidden text.\n:::\n'
  const alias = (await (await page.request.post('/api/notes', { data: { content } })).json()).alias
  await page.goto('/n/' + alias)
  const editor = page.getByTestId('editor')
  const md = async () => (await page.request.get(`/api/notes/${alias}/download.md`)).text()
  const type = async (line: string, text: string) => {
    await editor.locator('.cm-line', { hasText: line }).click()
    await page.keyboard.press('End')
    await page.keyboard.type(text)
  }

  await type('Also success', ' More.')
  await expect.poll(md).toContain(':::info\nAlso success. More.\n:::')
  await expect(editor.locator('.cm-line.cm-lp-box-info', { hasText: 'Also success. More.' })).toHaveCount(1)
  await expect(editor).not.toContainText(':::')
  await editor.getByLabel('Box type').first().selectOption('warning')
  await expect.poll(md).toContain(':::warning\nAlso success. More.\n:::')
  await expect(editor.locator('.cm-line.cm-lp-box-warning')).not.toHaveCount(0)

  await type('Good to know', ' Really.')
  await expect.poll(md).toContain('> [!NOTE]\n> Good to know. Really.')
  await editor.getByLabel('Callout type').selectOption('tip')
  await expect.poll(md).toContain('> [!TIP]\n> Good to know. Really.')

  await type('What it means', ' Exactly.')
  await expect.poll(md).toContain('Term\n: What it means. Exactly.')
  await expect(editor.locator('.cm-line.cm-lp-dd')).toHaveText('What it means. Exactly.')

  await type('Click to open', ' now')
  await type('Hidden text', ' Shown here.')
  await expect.poll(md).toContain(':::spoiler Click to open now\nHidden text. Shown here.\n:::')
})

test('a link under the cursor shows a card that opens, edits or removes it', async ({ page, context }) => {
  const alias = (await (await page.request.post('/api/notes', { data: { content: sample } })).json()).alias
  await page.goto('/n/' + alias)
  const editor = page.getByTestId('editor')
  const card = page.getByTestId('link-card')
  await expect(card).toHaveCount(0)
  await editor.locator('.cm-lp-link').click()
  await expect(card.getByRole('link', { name: 'https://example.com' })).toHaveAttribute('target', '_blank')
  const popup = context.waitForEvent('page')
  await card.getByRole('link', { name: 'https://example.com' }).click()
  expect((await popup).url()).toContain('example.com')
  await (await popup).close()

  await editor.locator('.cm-line', { hasText: 'Quarterly review' }).click()
  await expect(card).toHaveCount(0)
  const direct = context.waitForEvent('page')
  await editor.locator('.cm-lp-link').click({ modifiers: ['ControlOrMeta'] })
  expect((await direct).url()).toContain('example.com')
  await (await direct).close()

  await editor.locator('.cm-lp-link').click()
  await card.getByRole('button', { name: 'Edit link' }).click()
  await expect(page.getByTestId('link-popover').getByLabel('Address')).toHaveValue('https://example.com')
  await page.keyboard.press('Escape')
  await editor.locator('.cm-lp-link').click()
  await card.getByRole('button', { name: 'Remove link' }).click()
  await expect.poll(async () => (await page.request.get(`/api/notes/${alias}/download.md`)).text()).toContain('for the Q4 review.')
})

test('a link to a document opens it from its card', async ({ page }) => {
  const target = (await (await page.request.post('/api/notes', { data: { content: '# Target doc\n' } })).json()).alias
  const alias = (await (await page.request.post('/api/notes', { data: { content: `See [[${target}|Target doc]] here.\n` } })).json()).alias
  await page.goto('/n/' + alias)
  await page.getByTestId('editor').locator('.cm-lp-notelink').click()
  await page.getByTestId('link-card').getByRole('link', { name: 'Open Target doc' }).click()
  await expect(page).toHaveURL(new RegExp('/n/' + target + '$'))
})
