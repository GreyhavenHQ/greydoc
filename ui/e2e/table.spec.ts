import { expect, test, type Page } from '@playwright/test'
import { sample } from './sample'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('greydoc-mode', 'live'))
})

async function openSample(page: Page): Promise<string> {
  const alias = (await (await page.request.post('/api/notes', { data: { content: sample } })).json()).alias
  await page.goto('/n/' + alias)
  return alias
}

const markdown = async (page: Page, alias: string) => (await page.request.get(`/api/notes/${alias}/download.md`)).text()
const tableLines = (md: string) => md.split('\n').filter((l) => l.startsWith('|'))
const cell = (page: Page, text: string) => page.getByTestId('editor').locator('.cm-lp-grid td, .cm-lp-grid th').filter({ hasText: text })

test('typing in a grid cell changes only that cell', async ({ page }) => {
  const alias = await openSample(page)
  await cell(page, 'Bob').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Smith')
  // Tab five times: four cells of the last row, then past the last cell, which adds a row.
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab')
  await page.keyboard.type('Oceania')
  await expect.poll(async () => tableLines(await markdown(page, alias)).at(-1)).toBe('| Oceania |  |  |  |')
  const before = tableLines(sample)
  const after = tableLines(await markdown(page, alias))
  expect(after).toEqual([...before.slice(0, 3), '| North America | 2.4 M$ | +12 % | Bob Smith |', before[4], '| Oceania |  |  |  |'])
  const rest = (md: string) => md.split('\n').filter((l) => !l.startsWith('|'))
  expect(rest(await markdown(page, alias))).toEqual(rest(sample))
})

test('the grid moves with Tab, Shift+Tab and Enter, and escapes pipes', async ({ page }) => {
  const alias = await openSample(page)
  await cell(page, 'Europe').click()
  await page.keyboard.press('Enter')
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('End')
  await page.keyboard.type(' a|b')
  await expect.poll(async () => tableLines(await markdown(page, alias))[3]).toBe('| North America! | 2.4 M$ | +12 % | Bob |')
  expect(tableLines(await markdown(page, alias))[2]).toBe('| Europe | 1.2 M€ | +8 % | Alice a\\|b |')
  // Enter on the last row adds a row below and moves into it.
  await cell(page, 'Chen').click()
  await page.keyboard.press('Enter')
  await page.keyboard.type('Dana')
  await expect.poll(async () => tableLines(await markdown(page, alias)).at(-1)).toBe('|  |  |  | Dana |')
})

test('two people edit different cells at the same time', async ({ browser }) => {
  const a = await browser.newPage()
  const b = await browser.newPage()
  for (const p of [a, b]) await p.addInitScript(() => localStorage.setItem('greydoc-mode', 'live'))
  const alias = await openSample(a)
  await b.goto('/n/' + alias)
  await cell(a, 'Alice').click()
  await cell(b, 'Chen').click()
  await a.keyboard.press('End')
  await b.keyboard.press('End')
  for (const ch of 'xyz') {
    await a.keyboard.type(ch)
    await b.keyboard.type(ch.toUpperCase())
  }
  await expect.poll(async () => tableLines(await markdown(a, alias)).slice(2)).toEqual([
    '| Europe | 1.2 M€ | +8 % | Alicexyz |',
    '| North America | 2.4 M$ | +12 % | Bob |',
    '| Asia | 0.9 M$ | +3 % | ChenXYZ |',
  ])
  await expect(cell(a, 'Chen')).toHaveText('ChenXYZ')
  await expect(cell(b, 'Alice')).toHaveText('Alicexyz')
  expect(await a.evaluate(() => document.activeElement?.textContent)).toBe('Alicexyz')
  expect(await b.evaluate(() => document.activeElement?.textContent)).toBe('ChenXYZ')
  await a.close()
  await b.close()
})

test('bold and undo work inside a cell', async ({ page }) => {
  const alias = await openSample(page)
  await cell(page, 'Asia').dblclick()
  await page.keyboard.press('ControlOrMeta+b')
  await expect.poll(async () => tableLines(await markdown(page, alias))[4]).toBe('| **Asia** | 0.9 M$ | +3 % | Chen |')
  await page.waitForTimeout(600)
  await page.keyboard.press('End')
  await page.keyboard.type('X')
  await expect.poll(async () => tableLines(await markdown(page, alias))[4]).toBe('| **Asia**X | 0.9 M$ | +3 % | Chen |')
  await page.waitForTimeout(600)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => tableLines(await markdown(page, alias))[4]).toBe('| **Asia** | 0.9 M$ | +3 % | Chen |')
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => tableLines(await markdown(page, alias))[4]).toBe('| Asia | 0.9 M$ | +3 % | Chen |')
  await page.keyboard.press('Escape')
  await expect(cell(page, 'Asia').locator('strong')).toHaveCount(0)
})
