import { expect, test, type Page } from '@playwright/test'

async function dropFiles(page: Page, files: { name: string; type: string; base64: string }[]) {
  const dt = await page.evaluateHandle((list) => {
    const dt = new DataTransfer()
    for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name, { type: f.type }))
    return dt
  }, files)
  const target = page.locator('main')
  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await expect(page.getByTestId('drop-overlay')).toBeVisible()
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  await target.dispatchEvent('drop', { dataTransfer: dt })
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
}

test('dropping a greydoc zip or a Markdown file on the note list imports it', async ({ page }) => {
  await page.request.post('/api/notes', { data: { content: '# Bundled note\n\nbody', alias: 'bundle-e2e' } })
  const zip = await (await page.request.get('/api/notes/bundle-e2e/export.zip')).body()

  await page.goto('/?scope=all')
  await expect(page.getByTestId('note-list')).toContainText('Bundled note')
  await dropFiles(page, [
    { name: 'bundled-note.zip', type: 'application/zip', base64: zip.toString('base64') },
    { name: 'from-disk.md', type: 'text/markdown', base64: Buffer.from('# From a Markdown file\n').toString('base64') },
  ])
  await expect(page.getByText(/Imported “Bundled note” at \/[a-z0-9]+\. Its old address is taken here\./)).toBeVisible()
  await expect(page.getByText('Imported “From a Markdown file”')).toBeVisible()
  await expect(page.getByTestId('note-list').locator('li', { hasText: 'Bundled note' })).toHaveCount(2)
  await expect(page.getByTestId('note-list')).toContainText('From a Markdown file')
})
