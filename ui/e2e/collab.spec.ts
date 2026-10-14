import { expect, test, type Page } from '@playwright/test'

async function typeInEditor(page: Page, text: string) {
  await page.locator('[data-testid=editor] .cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
}

test('new note opens an editor ready for typing', async ({ page }) => {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\/[a-z0-9]+$/)
  await expect(page.locator('[data-testid=editor] .cm-content')).toBeFocused()
  await page.keyboard.type('# Hello greydoc')
  await expect(page.getByTestId('note-title')).toHaveText('Hello greydoc')
  await expect(page.getByTestId('preview').locator('h1')).toHaveText('Hello greydoc')
})

test('two browsers editing one note converge and see each other', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage()
  await a.goto('/new')
  await expect(a).toHaveURL(/\/n\/[a-z0-9]+$/)
  const url = a.url()
  await typeInEditor(a, 'from A.')

  const b = await (await browser.newContext()).newPage()
  await b.goto(url)
  await expect(b.locator('[data-testid=editor] .cm-content')).toContainText('from A.')
  await typeInEditor(b, ' from B.')

  await expect(a.getByTestId('preview')).toHaveText('from A. from B.')
  await expect(b.getByTestId('preview')).toHaveText('from A. from B.')
  await expect(a.getByTestId('presence').locator('span')).toHaveCount(2)
  await expect(a.locator('.cm-ySelectionCaret')).toHaveCount(1)
})

test('home lists notes and filters by tag', async ({ page }) => {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\//)
  await typeInEditor(page, '---\ntags: [design, q4]\n---\n# Tagged note')
  await page.waitForTimeout(600)
  await page.goto('/?scope=all')
  await expect(page.getByTestId('note-list')).toContainText('Tagged note')
  await page.getByTestId('tag-filter').getByRole('button', { name: /#q4/ }).click()
  await expect(page.getByTestId('note-list').locator('li')).toHaveCount(1)
})
