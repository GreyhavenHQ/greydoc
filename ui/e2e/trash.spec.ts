import { expect, test } from '@playwright/test'

test('trash, restore and audit', async ({ page }) => {
  const resp = await page.request.post('/api/notes', { data: { content: '# Old plan\n\ntext' } })
  const alias = (await resp.json()).alias
  await page.goto('/n/' + alias)
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Move to trash' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('Moved to the trash', { exact: true })).toBeVisible()

  await page.goto('/n/' + alias)
  await expect(page.getByText('This note is in the trash.')).toBeVisible()

  await page.goto('/audit')
  const trashed = page.getByTestId('audit-event').filter({ hasText: 'moved the note to the trash' })
  await expect(trashed).toContainText('Old plan')
  await expect(trashed).toContainText('in trash')

  await page.goto('/trash')
  await expect(page.getByTestId('trash-list')).toContainText('Old plan')
  await page.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByText('Restored', { exact: true })).toBeVisible()
  await page.goto('/n/' + alias)
  await expect(page.getByTestId('editor').locator('.cm-lp-h1')).toHaveText('Old plan')

  await page.goto('/audit')
  await expect(page.getByTestId('audit-event').first()).toContainText('restored the note from the trash')
})
