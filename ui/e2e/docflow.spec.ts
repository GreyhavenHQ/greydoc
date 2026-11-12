import { expect, test, type Page } from '@playwright/test'
import { startWith } from './prefs'

// A person who does not know Markdown writes in the document style. What they type MUST read as typed.
startWith({ default_mode: 'live', live_style: 'document' })

async function open(page: Page, content: string): Promise<string> {
  const alias = (await (await page.request.post('/api/notes', { data: { content } })).json()).alias
  await page.goto('/n/' + alias)
  return alias
}
const md = async (page: Page, alias: string) => (await page.request.get(`/api/notes/${alias}/download.md`)).text()
const editor = (page: Page) => page.getByTestId('editor')

const lines = ['# Not a heading', '- not a list', '1. not a list', '> not a quote', 'x == y, a ++ b, 5 * 3, a_b_c, cost $5 or $6', ':smile: at 10:30, a | b, [[brackets]]']

test('typed Markdown characters stay text, in the editor and in the view', async ({ page }) => {
  const alias = await open(page, 'start\n')
  await editor(page).locator('.cm-line', { hasText: 'start' }).click()
  await page.keyboard.press('End')
  for (const l of lines) {
    await page.keyboard.press('Enter')
    await page.keyboard.type(l)
    await page.keyboard.press('Escape')
  }
  await expect.poll(async () => (await md(page, alias)).split('\n').length).toBeGreaterThan(6)
  const shown = await editor(page).locator('.cm-line').allInnerTexts()
  for (const l of lines) expect(shown).toContain(l)
  await expect(editor(page).locator('.cm-lp-h1, .cm-lp-bullet, .cm-lp-quote, .cm-lp-mark, .cm-lp-emoji, .cm-lp-notelink')).toHaveCount(0)

  await page.goto('/n/' + alias + '?view')
  const view = page.getByTestId('preview')
  for (const l of lines) await expect(view).toContainText(l)
  await expect(view.locator('h1, ul, ol, blockquote, mark, em, .katex, a.note-link')).toHaveCount(0)
})

test('[[ lists documents and makes a link only on a choice', async ({ page }) => {
  await page.request.post('/api/notes', { data: { content: '# Zebra plan\n' } })
  const alias = await open(page, 'start\n')
  await editor(page).locator('.cm-line', { hasText: 'start' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' see [[zeb')
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Zebra plan')
  await expect(editor(page).locator('.cm-lp-notelink')).toHaveCount(0)
  await page.locator('.cm-tooltip-autocomplete li', { hasText: 'Zebra plan' }).click()
  await expect(editor(page).locator('.cm-lp-notelink')).toHaveText('Zebra plan')
  await expect.poll(() => md(page, alias)).toMatch(/^start see \[\[[a-z0-9]+\|Zebra plan\]\]\n?$/)

  await page.keyboard.type(' and [[nothing')
  await page.keyboard.press('Escape')
  await expect(editor(page).locator('.cm-line', { hasText: 'and' })).toContainText('and [[nothing')
  await expect(editor(page).locator('.cm-lp-notelink')).toHaveCount(1)
})

test('Backspace removes a typed star whole', async ({ page }) => {
  const alias = await open(page, 'start\n')
  await editor(page).locator('.cm-line', { hasText: 'start' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' a*b')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Backspace')
  await expect.poll(() => md(page, alias)).toBe('start ab\n')
})

test('the arrow keys stop on every blank line, between paragraphs and headings too', async ({ page }) => {
  const alias = await open(page, '# Title\n\nfirst\n\n\nsecond\n')
  await editor(page).locator('.cm-line', { hasText: 'second' }).click()
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowUp')
  await page.keyboard.type('x')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.type('y')
  await expect.poll(() => md(page, alias)).toBe('# Title\n\nfirst\nx\n\nsecond\ny')
})

test('the arrow keys move one line at a time over blank lines', async ({ page }) => {
  const alias = await open(page, 'a\n\n\n\nb\n')
  await editor(page).locator('.cm-line', { hasText: /^b$/ }).click()
  await page.keyboard.press('End')
  for (const n of ['1', '2', '3']) {
    await page.keyboard.press('ArrowUp')
    await page.keyboard.type(n)
  }
  await expect.poll(() => md(page, alias)).toBe('a\n3\n2\n1\nb\n')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('End')
  for (const n of ['x', 'y', 'z']) {
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('End')
    await page.keyboard.type(n)
  }
  await expect.poll(() => md(page, alias)).toBe('a\n3x\n2y\n1z\nb\n')
})

test('the arrow keys pass a diagram in one move, both ways, without opening its source', async ({ page }) => {
  const alias = await open(page, 'top\n\n```mermaid\ngraph LR\nA-->B\n```\n\nbottom\n')
  await expect(editor(page).locator('.cm-lp-mermaid')).toHaveCount(1)
  await editor(page).locator('.cm-line', { hasText: 'top' }).click()
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowDown')
    await expect(editor(page).locator('.cm-lp-mermaid')).toHaveCount(1)
  }
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('ArrowUp')
    await expect(editor(page).locator('.cm-lp-mermaid')).toHaveCount(1)
  }
  await page.keyboard.press('End')
  await page.keyboard.type('.')
  await expect.poll(() => md(page, alias)).toBe('top.\n\n```mermaid\ngraph LR\nA-->B\n```\n\nbottom!\n')
})

test('the toolbar still formats, and Enter continues a list', async ({ page }) => {
  const alias = await open(page, 'one\n')
  await editor(page).locator('.cm-line', { hasText: 'one' }).click()
  await page.getByTestId('format-toolbar').getByRole('button', { name: /^Bulleted list/ }).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('two')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.press('ControlOrMeta+b')
  await expect.poll(() => md(page, alias)).toBe('- one\n- **two**\n')
  await expect(editor(page).locator('.cm-lp-strong')).toHaveText('two')
})
