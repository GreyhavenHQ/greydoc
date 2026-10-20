import { expect, test, type Page } from '@playwright/test'

test('pinned documents come first, by name', async ({ page }) => {
  const id = Date.now().toString(36)
  const titles = ['Zeta', 'alpha', 'Mid'].map((t) => `${t} ${id}`)
  const [zeta, alpha, mid] = titles
  for (const t of titles) await page.request.post('/api/notes', { data: { content: `# ${t}\n` } })

  const order = async (p: Page) => {
    const rows = await p.getByTestId('note-list').locator('li').allTextContents()
    return rows.map((r) => titles.find((t) => r.includes(t))).filter(Boolean)
  }
  const row = (t: string) => page.getByTestId('note-list').locator('li').filter({ hasText: t })

  await page.goto('/')
  await expect.poll(() => order(page)).toEqual([mid, alpha, zeta])
  await row(zeta).getByRole('button', { name: 'Pin' }).click()
  await row(alpha).getByRole('button', { name: 'Pin' }).click()
  await expect.poll(() => order(page)).toEqual([alpha, zeta, mid])

  await page.reload()
  await expect.poll(() => order(page)).toEqual([alpha, zeta, mid])

  await row(alpha).getByRole('button', { name: 'Unpin' }).click()
  await expect.poll(() => order(page)).toEqual([zeta, mid, alpha])
})
