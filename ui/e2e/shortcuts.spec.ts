import { expect, test, type Page } from '@playwright/test'

// These tests read the preview pane, so they use the split view.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('greydoc-mode', 'both'))
})

async function newNote(page: Page, text: string) {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\/[a-z0-9]+$/)
  await expect(page.locator('[data-testid=editor] .cm-content')).toBeFocused()
  await page.keyboard.type(text)
}

const source = (page: Page) => page.locator('[data-testid=editor] .cm-content')

test('Ctrl+B toggles bold on the selection', async ({ page }) => {
  await newNote(page, 'word')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('ControlOrMeta+b')
  await expect(source(page)).toHaveText('**word**')
  await expect(page.getByTestId('preview').locator('strong')).toHaveText('word')
  await page.keyboard.press('ControlOrMeta+b')
  await expect(source(page)).toHaveText('word')
  await expect(page.getByTestId('preview').locator('strong')).toHaveCount(0)
})

test('heading and list keys act on lines', async ({ page }) => {
  await newNote(page, 'Plan')
  await page.keyboard.press('ControlOrMeta+Alt+2')
  await expect(page.getByTestId('preview').locator('h2')).toHaveText('Plan')
  await page.keyboard.press('ControlOrMeta+Alt+0')
  await expect(page.getByTestId('preview').locator('h2')).toHaveCount(0)
  await page.keyboard.press('End')
  await page.keyboard.type('\na\nb')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+Shift+8')
  await expect(page.getByTestId('preview').locator('ul > li')).toHaveCount(3)
  await page.keyboard.press('ControlOrMeta+Shift+8')
  await expect(page.getByTestId('preview').locator('li')).toHaveCount(0)
})

test('Ctrl+Alt+M comments on the selection', async ({ page }) => {
  await newNote(page, 'The budget is final.')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('ControlOrMeta+Alt+m')
  await expect(page.getByTestId('comment-input')).toBeVisible()
})

test('shortcuts do nothing while a dialog is open or in a comment box', async ({ page }) => {
  await newNote(page, 'word')
  await page.keyboard.press('Shift+Home')
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Timeline' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.press('Control+Alt+e')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(source(page)).toHaveText('word')
  await expect(page.getByTestId('preview')).toBeVisible()

  await source(page).click()
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('ControlOrMeta+Alt+m')
  await page.getByTestId('comment-input').fill('Why?')
  await page.keyboard.press('Control+Alt+v')
  await page.keyboard.press('ControlOrMeta+b')
  await expect(page.getByTestId('comment-input')).toHaveValue('Why?')
  await expect(source(page)).toHaveText('word')
  await expect(page.getByTestId('preview')).toBeVisible()
  await expect(source(page)).toBeVisible()
})
