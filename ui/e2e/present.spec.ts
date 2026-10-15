import { expect, test } from '@playwright/test'

test('a note with type: slide gets a Present button in the list and in the top bar', async ({ page }) => {
  await page.request.post('/api/notes', { data: { content: '---\ntype: slide\n---\n# Quarterly deck\n\n---\n\n# Second', alias: 'present-deck' } })
  await page.request.post('/api/notes', { data: { content: '# Plain page', alias: 'present-plain' } })

  await page.goto('/?scope=all')
  const deck = page.getByTestId('note-list').locator('li', { hasText: 'Quarterly deck' })
  await expect(deck.getByRole('link', { name: 'Present' })).toHaveAttribute('href', '/p/present-deck')
  await expect(page.getByTestId('note-list').locator('li', { hasText: 'Plain page' }).getByRole('link', { name: 'Present' })).toHaveCount(0)

  // The pin sits left of Present, and both line up with the first line of the title.
  await deck.hover()
  const title = await deck.getByText('Quarterly deck').boundingBox()
  const present = await deck.getByRole('link', { name: 'Present' }).boundingBox()
  const pin = await deck.getByRole('button', { name: 'Pin' }).boundingBox()
  const mid = (b: { y: number; height: number } | null) => (b ? b.y + b.height / 2 : NaN)
  expect(Math.abs(mid(present) - mid(title))).toBeLessThan(2)
  expect(Math.abs(mid(pin) - mid(title))).toBeLessThan(2)
  expect(pin!.x).toBeLessThan(present!.x)

  await page.goto('/n/present-deck')
  await expect(page.getByRole('link', { name: 'Present' })).toHaveAttribute('href', '/p/present-deck')
  await page.goto('/n/present-plain')
  await expect(page.getByTestId('preview')).toContainText('Plain page')
  await expect(page.getByRole('link', { name: 'Present' })).toHaveCount(0)
})
