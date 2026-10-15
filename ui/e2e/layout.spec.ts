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
  await expect(doc.locator('nav.toc')).toHaveCount(0)
  await expect(page.getByTestId('toc-sidebar').getByRole('link', { name: 'Introduction' })).toBeVisible()
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

test('the table of contents opens the section being read, like HedgeDoc', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  const filler = Array.from({ length: 30 }, (_, i) => `Line ${i} of the section.`).join('\n\n')
  const content = `# Setup\n\n${filler}\n\n## Install\n\n${filler}\n\n# Usage\n\n${filler}\n\n## Daily work\n\n${filler}`
  const alias = (await (await page.request.post('/api/notes', { data: { content } })).json()).alias
  await page.goto('/s/' + alias)
  const toc = page.getByTestId('toc-sidebar')
  await expect(toc.getByRole('link')).toHaveText(['Setup', 'Install', 'Usage'])
  await expect(toc.getByRole('link', { name: 'Setup' })).toHaveAttribute('aria-current', 'location')
  await toc.getByRole('link', { name: 'Usage' }).click()
  await expect(toc.getByRole('link', { name: 'Usage' })).toHaveAttribute('aria-current', 'location')
  await expect(toc.getByRole('link')).toHaveText(['Setup', 'Usage', 'Daily work'])
  await expect(page).toHaveURL(/#usage$/)
  await toc.getByRole('button', { name: 'Expand all' }).click()
  await expect(toc.getByRole('link')).toHaveText(['Setup', 'Install', 'Usage', 'Daily work'])
})

test('the editor shows the table of contents in preview-only mode', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  const alias = (await (await page.request.post('/api/notes', { data: { content: '# One\n\ntext\n\n## Two\n\ntext' } })).json()).alias
  await page.goto('/n/' + alias + '?view')
  await expect(page.getByTestId('toc-sidebar').getByRole('link')).toHaveText(['One', 'Two'])
  await page.goto('/n/' + alias + '?both')
  await expect(page.getByTestId('preview').locator('h2')).toHaveText('Two')
  await expect(page.getByTestId('toc-sidebar')).toHaveCount(0)
})

test('[[alias]] links to another note and the editor completes it', async ({ page }) => {
  const target = (await (await page.request.post('/api/notes', { data: { content: '# Target note for links', alias: 'link-target' } })).json()).alias
  const content = 'See [[link-target]], [[link-target|the target]] and [[no-such-note]].'
  const alias = (await (await page.request.post('/api/notes', { data: { content } })).json()).alias
  await page.goto('/s/' + alias)
  const links = page.getByTestId('view-page').locator('a.note-link')
  await expect(links.nth(0)).toHaveText('Target note for links')
  await expect(links.nth(0)).toHaveAttribute('href', '/n/' + target)
  await expect(links.nth(1)).toHaveText('the target')
  await expect(links.nth(2)).toHaveClass(/note-link-missing/)

  await page.goto('/n/' + alias + '?edit')
  await page.locator('[data-testid=editor] .cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' Also [[Target note')
  const option = page.locator('.cm-tooltip-autocomplete li', { hasText: 'Target note for links' })
  await expect(option).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('Also [[link-target]]')
  await expect(page.getByTestId('editor').locator('.cm-content')).not.toContainText('[[link-target]]]')
})
