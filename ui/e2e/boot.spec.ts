import { expect, test } from '@playwright/test'

test('the view page shows the note with no API round trip, and images load lazily from a smaller copy', async ({ page }) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await page.request.post('/api/notes', { data: { content: '# Holder\n', alias: 'boot-holder' } })
  const up = await page.request.post('/api/notes/boot-holder/media', { multipart: { file: { name: 'a.png', mimeType: 'image/png', buffer: png } } })
  const { url } = await up.json()
  await page.request.post('/api/notes', { data: { content: `# Boot\n\n![shot](${url})\n`, alias: 'boot-view' } })

  const api: string[] = []
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (path.startsWith('/api/')) api.push(path)
  })
  await page.goto('/s/boot-view')
  await expect(page.getByTestId('view-page').locator('h1')).toHaveText('Boot')
  const img = page.getByTestId('view-page').locator('img')
  await expect(img).toHaveAttribute('loading', 'lazy')
  await expect(img).toHaveAttribute('src', url + '?w=1600')
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1)
  expect(api).toEqual([])
})
