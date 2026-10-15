import { expect, test } from '@playwright/test'

const wide = '```mermaid\nflowchart LR\n' + Array.from({ length: 9 }, (_, i) => `  N${i}[Step number ${i}] --> N${i + 1}[Step number ${i + 1}]`).join('\n') + '\n```'

test('image width and height attributes are respected', async ({ page }) => {
  const content = '# Images\n\n<img src="/favicon.svg" height="80px">\n\n![small](/favicon.svg =40x40)\n'
  const alias = (await (await page.request.post('/api/notes', { data: { content } })).json()).alias
  await page.goto('/s/' + alias)
  const imgs = page.getByTestId('view-page').locator('img')
  await expect(imgs).toHaveCount(2)
  await expect.poll(async () => (await imgs.nth(0).boundingBox())?.height).toBe(80)
  await expect.poll(async () => (await imgs.nth(1).boundingBox())?.width).toBe(40)
})

test('a wide suggestion stays inside the editor in split view', async ({ page }) => {
  const alias = (await (await page.request.post('/api/notes', { data: { content: '# Wide\n\nhello world\n' } })).json()).alias
  await page.request.post(`/api/notes/${alias}/suggestions`, { data: { quote: 'hello world', proposed: 'hello world\n\n' + wide } })
  await page.goto('/n/' + alias + '?both')
  const card = page.getByTestId('suggestion-card')
  await expect(card.locator('svg').first()).toBeVisible({ timeout: 15_000 })
  const editor = (await page.getByTestId('editor').boundingBox())!
  const box = (await card.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(editor.x + editor.width + 1)
})

test('the features page renders the guide with live examples', async ({ page }) => {
  await page.goto('/features')
  const doc = page.getByTestId('features-page')
  await expect(doc.locator('h1').first()).toHaveText('Features')
  await expect(doc.locator('nav.toc')).toBeVisible()
  await expect(doc.locator('.mermaid-block svg').first()).toBeVisible({ timeout: 15_000 })
  await expect(doc.locator('.katex').first()).toBeVisible()
})

test('the Markdown help shows example images at their own size', async ({ page }) => {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\//)
  await page.getByRole('button', { name: 'Markdown help' }).click()
  const imgs = page.getByTestId('syntax-help').locator('.markdown-body img')
  await expect(imgs).toHaveCount(2)
  await expect.poll(async () => (await imgs.nth(0).boundingBox())?.width).toBe(32)
  await expect.poll(async () => (await imgs.nth(1).boundingBox())?.width).toBe(64)
})
