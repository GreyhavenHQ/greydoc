import { expect, test, type Page } from '@playwright/test'

const table = '| ' + Array.from({ length: 12 }, (_, i) => `Column ${i}`).join(' | ') + ' |\n|' + '---|'.repeat(12) + '\n| ' + Array.from({ length: 12 }, (_, i) => `value ${i}`).join(' | ') + ' |\n'

test.use({ viewport: { width: 1440, height: 900 } })

async function noteWith(page: Page, content: string) {
  return (await (await page.request.post('/api/notes', { data: { content } })).json()).alias as string
}

async function source(page: Page, alias: string) {
  return (await page.request.get(`/api/notes/${alias}/download.md`)).text()
}

const width = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())?.width

test('a document renders in a 728px column, and 1200px once wide', async ({ page, browser }) => {
  const alias = await noteWith(page, '# Report\n\n' + table)
  await page.goto('/n/' + alias + '?view')
  await expect.poll(() => width(page, '[data-testid=preview]')).toBe(728)

  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Wide layout' }).click()
  await expect.poll(() => source(page, alias)).toBe('---\nwidth: wide\n---\n# Report\n\n' + table)
  await expect.poll(() => width(page, '[data-testid=preview]')).toBe(1200)

  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await other.addInitScript(() => localStorage.setItem('greydoc-mode', 'live'))
  const b = await other.newPage()
  await b.goto('/n/' + alias)
  await expect.poll(() => width(b, '[data-testid=editor] .cm-content')).toBe(1264)

  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Wide layout' }).click()
  await expect.poll(() => source(page, alias)).toBe('# Report\n\n' + table)
  await expect.poll(() => width(page, '[data-testid=preview]')).toBe(728)
  await expect.poll(() => width(b, '[data-testid=editor] .cm-content')).toBe(792)
  await other.close()
})

test('turning the wide layout off keeps the other front matter keys', async ({ page }) => {
  const alias = await noteWith(page, '---\ntitle: Plan\nwidth: wide\ntags: a, b\n---\nbody\n')
  await page.goto('/n/' + alias + '?view')
  await page.getByRole('button', { name: 'More' }).click()
  const box = page.getByRole('menuitemcheckbox', { name: 'Wide layout' })
  await expect(box).toHaveAttribute('aria-checked', 'true')
  await box.click()
  await expect.poll(() => source(page, alias)).toBe('---\ntitle: Plan\ntags: a, b\n---\nbody\n')
})

test('the shared page and the HTML download use the wide column', async ({ page }) => {
  const alias = await noteWith(page, '---\nwidth: wide\n---\n# Report\n\n' + table)
  await page.goto('/s/' + alias)
  const doc = '[data-testid=view-page] [data-testid=preview]'
  await expect.poll(() => width(page, doc)).toBe(1200)
  const fits = await page.locator(doc + ' table').evaluate((t) => t.scrollWidth <= t.clientWidth)
  expect(fits).toBe(true)

  const downloading = page.waitForEvent('download')
  await page.goto('/s/' + alias + '?export=html')
  const fs = await import('node:fs/promises')
  const html = await fs.readFile((await (await downloading).path())!, 'utf8')
  expect(html).toContain('main{max-width:1200px;')
})

test('the table of contents does not cover a wide document', async ({ page }) => {
  const filler = Array.from({ length: 10 }, (_, i) => `Line ${i}.`).join('\n\n')
  const alias = await noteWith(page, `---\nwidth: wide\n---\n# One\n\n${table}\n${filler}\n\n# Two\n\n${filler}`)
  await page.goto('/s/' + alias)
  const toc = page.getByTestId('toc-sidebar')
  await expect(toc).toBeVisible()
  const text = (await page.locator('[data-testid=view-page] [data-testid=preview]').boundingBox())!
  const nav = (await toc.boundingBox())!
  expect(text.x + text.width).toBeLessThanOrEqual(nav.x)
  expect(nav.x + nav.width).toBeLessThanOrEqual(1440)
})
