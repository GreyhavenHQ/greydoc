import { expect, test } from '@playwright/test'

test.afterEach(async ({ request }) => {
  await request.patch('/api/me/prefs', { data: { default_mode: '', live_style: '' } })
})

const newNote = async (request: import('@playwright/test').APIRequestContext, text: string) =>
  (await (await request.post('/api/notes', { data: { content: text } })).json()).alias as string

test('settings choose the starting mode and the live style', async ({ page, request }) => {
  const first = await newNote(request, '# First\n\nSome **bold** text.\n')
  const second = await newNote(request, '# Second\n')
  await page.goto('/n/' + first)
  await expect(page.getByRole('radio', { name: /Split view/ })).toHaveAttribute('aria-checked', 'true')

  await page.goto('/settings')
  const card = page.getByTestId('editor-prefs')
  await card.getByRole('radio', { name: 'Live' }).click()
  await card.getByRole('radio', { name: 'Document' }).click()
  await expect.poll(async () => (await (await request.get('/api/me')).json()).prefs).toEqual({ default_mode: 'live', live_style: 'document' })

  await page.goto('/n/' + first)
  const editor = page.getByTestId('editor')
  await expect(editor.locator('.cm-live')).toHaveCount(1)
  await editor.locator('.cm-lp-strong').click()
  await expect(editor.locator('.cm-line', { hasText: 'Some' })).not.toContainText('*')

  // The header buttons change this document in this tab only.
  await page.getByRole('radio', { name: /Preview only/ }).click()
  await expect(page.getByTestId('editor')).toHaveCount(0)
  await page.goto('/n/' + second)
  await expect(page.getByTestId('editor').locator('.cm-live')).toHaveCount(1)
  await page.goto('/n/' + first)
  await expect(page.getByTestId('editor')).toHaveCount(0)
  await expect(page.getByTestId('preview')).toHaveCount(1)
})

test('a new note opens for editing when the default is preview', async ({ page, request }) => {
  await request.patch('/api/me/prefs', { data: { default_mode: 'preview' } })
  const alias = await newNote(request, '# Old\n')
  await page.goto('/n/' + alias)
  await expect(page.getByTestId('editor')).toHaveCount(0)
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\//)
  await expect(page.getByTestId('editor')).toHaveCount(1)
})
