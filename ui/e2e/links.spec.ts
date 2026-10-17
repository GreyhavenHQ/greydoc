import { expect, test, type Locator } from '@playwright/test'

const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of the introduction.`).join('\n\n')
const content = `# Q4 roadmap\n\n${filler}\n\n## Release plan\n\nShip in December.\n\n${filler}\n`

// atTop says whether el is at the top of its scroll area.
function atTop(el: Locator) {
  return el.evaluate((h) => {
    let p = h.parentElement
    while (p && p !== document.body && !/(auto|scroll)/.test(getComputedStyle(p).overflowY)) p = p.parentElement
    const top = p && p !== document.body ? p.getBoundingClientRect().top : 0
    const d = Math.round(h.getBoundingClientRect().top - top)
    return d >= -5 && d < 40
  })
}

test('a heading icon copies the address of the heading, and the address opens at it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const alias = (await (await page.request.post('/api/notes', { data: { content, alias: 'links-heading' } })).json()).alias
  await page.goto('/s/' + alias)
  const heading = page.getByTestId('view-page').locator('h2#release-plan')
  await heading.scrollIntoViewIfNeeded()
  await heading.hover()
  const icon = heading.locator('a.header-anchor')
  await expect(icon).toBeVisible()
  await icon.click()
  await expect(page).toHaveURL(/\/s\/links-heading#release-plan$/)
  await expect(page.getByText('Link copied')).toBeVisible()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toMatch(/\/s\/links-heading#release-plan$/)

  const fresh = await context.newPage()
  await fresh.goto(copied)
  await expect.poll(() => atTop(fresh.getByTestId('view-page').locator('h2#release-plan'))).toBe(true)

  await fresh.goto('/s/' + alias + '#Release-Plan')
  await expect.poll(() => atTop(fresh.getByTestId('view-page').locator('h2#release-plan'))).toBe(true)

  await fresh.goto('/n/' + alias + '?both#release-plan')
  const inPreview = fresh.getByTestId('preview').locator('h2#release-plan')
  await expect(inPreview).toBeVisible()
  await expect.poll(() => atTop(inPreview)).toBe(true)
})

test('[[alias#section]] links to a heading of another document, and the editor lists its headings', async ({ page }) => {
  await page.request.post('/api/notes', { data: { content, alias: 'links-target' } })
  const src = 'See [[links-target#release-plan]] and [[links-target#no-such-heading]].'
  const alias = (await (await page.request.post('/api/notes', { data: { content: src } })).json()).alias
  await page.goto('/s/' + alias)
  const links = page.getByTestId('view-page').locator('a.note-link')
  await expect(links.nth(0)).toHaveText('Q4 roadmap › Release plan')
  await expect(links.nth(0)).toHaveAttribute('href', '/n/links-target#release-plan')
  await expect(links.nth(1)).toHaveClass(/note-link-missing/)
  await expect(links.nth(1)).toHaveAttribute('title', 'No heading with this name in the document')

  await page.goto('/n/' + alias + '?edit')
  await page.locator('[data-testid=editor] .cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' Also [[links-target#')
  const option = page.locator('.cm-tooltip-autocomplete li', { hasText: 'Release plan' })
  await expect(option).toBeVisible()
  await option.click()
  await expect(page.getByTestId('editor').locator('.cm-content')).toContainText('Also [[links-target#release-plan|Release plan]]')
  await expect(page.getByTestId('editor').locator('.cm-content')).not.toContainText(']]]')

  await page.goto('/n/' + alias + '?view')
  await page.getByTestId('preview').locator('a.note-link').first().click()
  await expect(page).toHaveURL(/\/n\/links-target(\?[^#]*)?#release-plan$/)
  await expect.poll(() => atTop(page.getByTestId('preview').locator('h2#release-plan'))).toBe(true)
})
