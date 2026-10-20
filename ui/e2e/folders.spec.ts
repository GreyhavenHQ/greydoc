import { expect, test } from '@playwright/test'

test('create a folder, move two documents into it, trash and restore it', async ({ page }) => {
  await page.request.post('/api/notes', { data: { content: '# Folder plan', alias: 'folder-plan' } })
  await page.request.post('/api/notes', { data: { content: '# Folder notes', alias: 'folder-notes' } })

  await page.goto('/?scope=mine')
  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByLabel('Folder name').fill('Project X')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page).toHaveURL(/\/f\//)
  const folderURL = page.url()
  await expect(page.getByTestId('breadcrumb')).toContainText('Project X')

  await page.goto('/?scope=mine')
  const list = page.getByTestId('note-list')
  for (const title of ['Folder plan', 'Folder notes']) {
    const card = list.locator('li', { hasText: title })
    await card.hover()
    await card.getByRole('checkbox', { name: 'Select ' + title }).click()
  }
  await expect(page.getByTestId('selection-bar')).toContainText('2 selected')
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Move', exact: true }).click()
  await page.getByTestId('move-targets').getByRole('button', { name: 'Project X' }).click()
  await expect(page.getByTestId('move-changes')).toContainText('Nobody gains or loses access.')
  await page.getByRole('button', { name: 'Move to Project X' }).click()
  await expect(page.getByText('Moved 2 items to Project X')).toBeVisible()
  await expect(list.locator('li', { hasText: 'Folder plan' })).toHaveCount(0)
  await expect(page.getByTestId('folder-list')).toContainText('Project X')

  await page.getByTestId('folder-list').getByRole('link', { name: 'Project X' }).click()
  await expect(page).toHaveURL(folderURL)
  await expect(list).toContainText('Folder plan')
  await expect(list).toContainText('Folder notes')

  await page.goto('/?scope=all')
  await expect(list.locator('li', { hasText: 'Folder plan' })).toContainText('Project X')
  await expect(page.getByRole('tab', { name: 'All documents' })).toHaveAttribute('aria-selected', 'true')

  await page.goto(folderURL)
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'Folder actions' }).click()
  await page.getByRole('menuitem', { name: 'Move to trash' }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.goto('/n/folder-plan')
  await expect(page.getByText('This document is in the trash.')).toBeVisible()

  await page.goto('/trash')
  await expect(page.getByTestId('trash-folders')).toContainText('Project X')
  await expect(page.getByTestId('trash-list')).not.toContainText('Folder plan')
  await page.getByTestId('trash-folders').getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByText('Restored', { exact: true })).toBeVisible()
  await page.goto(folderURL)
  await expect(list).toContainText('Folder plan')
})

test('a new document from a folder page is created in that folder', async ({ page }) => {
  const r = await page.request.post('/api/folders', { data: { name: 'Drafts' } })
  const id = (await r.json()).folder.id
  await page.goto('/f/' + id)
  await page.getByRole('button', { name: 'New document' }).first().click()
  await expect(page).toHaveURL(/\/n\//)
  const alias = page.url().split('/n/')[1]
  const list = await (await page.request.get('/api/notes?folder=' + id)).json()
  expect(list.notes.map((n: { alias: string }) => n.alias)).toContain(alias)
})

test('the home page opens on My documents, and Recent is a list by last opened', async ({ page }) => {
  await page.request.post('/api/notes', { data: { content: '# Opened once', alias: 'opened-once' } })
  await page.goto('/n/opened-once')
  await expect(page.getByTestId('preview').locator('h1')).toHaveText('Opened once')
  await page.goto('/')
  await expect(page.getByRole('tab', { name: 'Documents', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Recent' }).click()
  await expect(page).toHaveURL(/scope=recent/)
  await expect(page.getByText('Last opened')).toBeVisible()
  await expect(page.getByTestId('note-list').locator('li').first()).toContainText('Opened once')
})
