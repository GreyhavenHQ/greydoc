import { expect, test } from '@playwright/test'

test('slide overview shows every slide and D switches the deck theme', async ({ page }) => {
  const resp = await page.request.post('/api/notes', { data: { content: '# One\n\n---\n\n# Two\n\n---\n\n# Three' } })
  const alias = (await resp.json()).alias
  await page.goto('/p/' + alias)
  const slides = page.locator('.reveal .slides > section')
  await expect(slides).toHaveCount(3)
  await page.keyboard.press('Escape')
  await expect(page.locator('.reveal.overview')).toHaveCount(1)
  for (const i of [0, 1, 2]) await expect(slides.nth(i)).toBeVisible()
  await page.keyboard.press('Escape')

  const dark = () => page.evaluate(() => document.body.classList.contains('greydoc-deck-dark'))
  const before = await dark()
  await page.keyboard.press('d')
  await expect.poll(dark).toBe(!before)
})

test('a slide keeps its place after a round trip through the overview', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 810 })
  // The image arrives late, as large screenshots do. The slide must not be centered without it.
  await page.route('**/late-image.svg', async (route) => {
    await new Promise((r) => setTimeout(r, 1000))
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="gray"/></svg>' })
  })
  const content = '# One\n\n---\n\n## Two\n\n![late](/late-image.svg)\n\nText under the image.'
  const alias = (await (await page.request.post('/api/notes', { data: { content } })).json()).alias
  await page.goto('/p/' + alias + '#/1')
  const heading = page.locator('.reveal .slides section.present h2')
  await expect(heading).toHaveText('Two')
  await expect.poll(() => page.locator('.reveal .slides section.present img').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(300)
  await page.waitForTimeout(500)
  const before = (await heading.boundingBox())!
  await page.keyboard.press('Escape')
  await expect(page.locator('.reveal.overview')).toHaveCount(1)
  await page.waitForTimeout(700)
  await page.keyboard.press('Escape')
  await expect(page.locator('.reveal.overview')).toHaveCount(0)
  await page.waitForTimeout(700)
  const after = (await heading.boundingBox())!
  expect(Math.abs(after.y - before.y)).toBeLessThan(1)
  expect(Math.abs(after.x - before.x)).toBeLessThan(1)
})

test('images on later slides load before the slide shows', async ({ page }) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await page.request.post('/api/notes', { data: { content: '# Holder\n', alias: 'deck-img-holder' } })
  const { url } = await (await page.request.post('/api/notes/deck-img-holder/media', { multipart: { file: { name: 'a.png', mimeType: 'image/png', buffer: png } } })).json()
  const resp = await page.request.post('/api/notes', { data: { content: `# One\n\n---\n\n# Two\n\n---\n\n![late](${url})` } })
  await page.goto('/p/' + (await resp.json()).alias)
  const img = page.locator('.reveal .slides img')
  await expect(img).toHaveAttribute('loading', 'eager')
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1)
  await expect(page.locator('.reveal .slides > section').first()).toHaveClass(/present/)
})
