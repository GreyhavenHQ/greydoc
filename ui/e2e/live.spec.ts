import { expect, test } from '@playwright/test'

async function noteWith(page: import('@playwright/test').Page, text: string): Promise<string> {
  const resp = await page.request.post('/api/notes', { data: { content: text } })
  expect(resp.status()).toBe(201)
  return (await resp.json()).alias
}

test('live mode is the default and renders markdown in place', async ({ page }) => {
  const alias = await noteWith(page, '# Plan\n\nSome **bold** text.\n\n```mermaid\ngraph LR\nA-->B\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] ship\n\nend')
  await page.goto('/n/' + alias)
  const editor = page.getByTestId('editor')
  await expect(editor.locator('.cm-live')).toHaveCount(1)
  await expect(page.getByTestId('preview')).toHaveCount(0)
  await expect(editor.locator('.cm-lp-h1')).toHaveText('Plan')
  await expect(editor.locator('.cm-lp-strong')).toHaveText('bold')
  await expect(editor.locator('.cm-lp-mermaid svg').first()).toBeVisible({ timeout: 15_000 })
  await expect(editor.locator('.cm-lp-table table')).toHaveCount(1)
  await expect(editor.locator('.cm-lp-check')).toHaveCount(1)

  // Clicking a rendered diagram shows its source for editing.
  await editor.locator('.cm-lp-mermaid').click()
  await expect(editor.locator('.cm-lp-mermaid')).toHaveCount(0)
  await expect(editor.locator('.cm-line', { hasText: 'A-->B' })).toHaveCount(1)

  // The checkbox toggles the task in the text.
  await editor.locator('.cm-lp-check').click()
  await expect(editor.locator('.cm-lp-done')).toHaveText('ship')
})

test('AI and comments work while reading in live mode', async ({ page }) => {
  const alias = await noteWith(page, '# Notes\n\nthe meeting was good i think\n\nend')
  await page.goto('/n/' + alias)
  const line = page.getByTestId('editor').locator('.cm-line', { hasText: 'the meeting was good' })
  await line.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
  const toolbar = page.getByTestId('selection-toolbar')
  await expect(toolbar.getByRole('button', { name: 'Comment' })).toBeVisible()
  await toolbar.getByRole('button', { name: 'AI' }).click()
  await page.getByRole('menuitem', { name: 'Refine' }).click()
  await expect(page.locator('.cm-sugg-ins .cm-sugg-text')).toHaveText('The meeting went well.')
  await page.getByRole('button', { name: 'Accept suggestion' }).click()
  await expect(page.getByTestId('editor').locator('.cm-line', { hasText: 'The meeting went well.' })).toHaveCount(1)
})

test('timeline shows the content of a suggestion', async ({ page }) => {
  const alias = await noteWith(page, 'alpha beta')
  await page.request.post(`/api/notes/${alias}/suggestions`, { data: { quote: 'beta', proposed: 'gamma', reason: 'clearer' } })
  await page.goto('/n/' + alias)
  await page.getByRole('button', { name: 'Timeline' }).click()
  await page.getByTestId('timeline-event').filter({ hasText: 'suggested a change' }).getByRole('button').first().click()
  const detail = page.getByTestId('timeline-suggestion')
  await expect(detail).toContainText('gamma')
  await expect(detail).toContainText('clearer')
  await detail.getByRole('button', { name: 'Accept' }).click()
  await expect(detail).toContainText('Accepted')
  await expect(page.getByTestId('editor').locator('.cm-line').first()).toHaveText('alpha gamma')
})

test('an AI diagram shows as a rendered card under the text and can be revised', async ({ page }) => {
  const alias = await noteWith(page, '# Flow\n\nUsers write, then review, then ship.\n\nend')
  await page.goto('/n/' + alias)
  const line = page.getByTestId('editor').locator('.cm-line', { hasText: 'Users write' })
  await line.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'AI' }).click()
  await page.getByRole('menuitem', { name: 'Make a diagram below' }).click()
  const card = page.getByTestId('suggestion-card')
  await expect(card.locator('svg').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.cm-sugg-del')).toHaveCount(0)
  await card.getByRole('textbox', { name: 'Ask the AI to change the suggestion' }).fill('make it vertical')
  await card.getByRole('textbox').press('Enter')
  await expect(page.getByText('New version ready')).toBeVisible()
  await expect(page.getByTestId('suggestion-card')).toHaveCount(1)
  await page.getByTestId('suggestion-card').getByRole('button', { name: 'Accept' }).click()
  await expect(page.getByTestId('suggestion-card')).toHaveCount(0)
  await expect(page.getByTestId('editor').locator('.cm-lp-mermaid svg').first()).toBeVisible({ timeout: 15_000 })
})
