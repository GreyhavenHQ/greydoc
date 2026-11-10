import { expect, test, type Page } from '@playwright/test'


async function typeInEditor(page: Page, text: string) {
  await page.locator('[data-testid=editor] .cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
}

async function setSlug(page: Page, slug: string) {
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Address' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Custom address').fill(slug)
  await dialog.getByRole('button', { name: 'Save' }).click()
}

test('the document menu sets a custom address and the id address keeps working', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await a.goto('/new')
  await expect(a).toHaveURL(/\/n\/[a-z0-9]+$/)
  const original = new URL(a.url()).pathname
  await typeInEditor(a, '# Slug plan\n')

  const ctxB = await browser.newContext()
  const b = await ctxB.newPage()
  await b.goto(original)
  await expect(b.locator('[data-testid=editor] .cm-content')).toContainText('Slug plan')

  await setSlug(a, 'team-roadmap')
  await expect(a.getByRole('dialog')).toBeHidden()
  await expect(a).toHaveURL(/\/n\/team-roadmap$/)
  await expect(b).toHaveURL(/\/n\/team-roadmap$/)
  await typeInEditor(a, 'after rename A.')
  await expect(b.locator('[data-testid=editor] .cm-content')).toContainText('after rename A.')

  await a.getByRole('button', { name: 'More' }).click()
  await a.getByRole('menuitem', { name: 'Address' }).click()
  const idLink = await a.getByRole('dialog').getByTestId('id-address').textContent()
  expect(idLink).toMatch(/\/n\/[0-9a-f]{32}$/)
  await a.keyboard.press('Escape')
  const c = await ctxA.newPage()
  await c.goto(new URL(idLink!).pathname)
  await expect(c).toHaveURL(/\/n\/team-roadmap$/)
  await expect(c.getByTestId('note-title')).toHaveText('Slug plan')

  await setSlug(a, 'roadmap-2027')
  await expect(a).toHaveURL(/\/n\/roadmap-2027$/)
  await expect(b).toHaveURL(/\/n\/roadmap-2027$/)
  await typeInEditor(b, ' after rename B.')
  await expect(a.locator('[data-testid=editor] .cm-content')).toContainText('after rename B.')

  await c.goto('/n/team-roadmap')
  await expect(c.getByText('This document does not exist.')).toBeVisible()
  await c.goto(original)
  await expect(c).toHaveURL(/\/n\/roadmap-2027$/)

  await c.goto('/audit?note=roadmap-2027')
  await expect(c.getByText('changed the address from /team-roadmap to /roadmap-2027')).toBeVisible()
})

test('the address dialog refuses reserved, taken and id-shaped addresses', async ({ page }) => {
  await page.request.post('/api/notes', { data: { content: '# Other', alias: 'slug-taken' } })
  await page.request.post('/api/notes', { data: { content: '# Mine', alias: 'slug-mine' } })
  await page.goto('/n/slug-mine')
  await expect(page.getByTestId('note-title')).toHaveText('Mine')
  for (const slug of ['api', 'slug-taken', '0123456789abcdef0123456789abcdef']) {
    await setSlug(page, slug)
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible()
    await page.keyboard.press('Escape')
  }
  await expect(page).toHaveURL(/\/n\/slug-mine$/)
})
