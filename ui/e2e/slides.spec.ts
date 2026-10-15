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
