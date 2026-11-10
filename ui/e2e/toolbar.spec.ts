import { expect, test, type Browser, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('greydoc-mode', 'live'))
})

async function open(page: Page, text: string): Promise<string> {
  const alias = (await (await page.request.post('/api/notes', { data: { content: text } })).json()).alias
  await page.goto('/n/' + alias)
  return alias
}

const markdown = async (page: Page, alias: string) => (await page.request.get(`/api/notes/${alias}/download.md`)).text()
const bar = (page: Page) => page.getByTestId('format-toolbar')

async function selectEnd(page: Page, line: string, chars: number) {
  await page.getByTestId('editor').locator('.cm-line', { hasText: line }).click()
  await page.keyboard.press('End')
  for (let i = 0; i < chars; i++) await page.keyboard.press('Shift+ArrowLeft')
}

test('bold, undo and redo from the toolbar', async ({ page }) => {
  const alias = await open(page, 'alpha beta\n')
  await selectEnd(page, 'alpha beta', 4)
  await expect(bar(page).getByRole('button', { name: /^Bold/ })).toHaveAttribute('aria-pressed', 'false')
  await bar(page).getByRole('button', { name: /^Bold/ }).click()
  await expect.poll(() => markdown(page, alias)).toBe('alpha **beta**\n')
  await expect(bar(page).getByRole('button', { name: /^Bold/ })).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(600)
  await bar(page).getByRole('button', { name: /^Undo/ }).click()
  await expect.poll(() => markdown(page, alias)).toBe('alpha beta\n')
  await bar(page).getByRole('button', { name: /^Redo/ }).click()
  await expect.poll(() => markdown(page, alias)).toBe('alpha **beta**\n')
})

test('paragraph style, lists and quote', async ({ page }) => {
  const alias = await open(page, 'Title\n\none\n')
  await page.getByTestId('editor').locator('.cm-line', { hasText: 'Title' }).click()
  await bar(page).getByRole('combobox', { name: 'Paragraph style' }).click()
  await page.getByRole('option', { name: 'Heading 2' }).click()
  await expect.poll(() => markdown(page, alias)).toBe('## Title\n\none\n')
  await expect(bar(page).getByRole('combobox', { name: 'Paragraph style' })).toHaveText('Heading 2')

  await page.getByTestId('editor').locator('.cm-line', { hasText: 'one' }).click()
  await bar(page).getByRole('button', { name: /^Numbered list/ }).click()
  await expect.poll(() => markdown(page, alias)).toBe('## Title\n\n1. one\n')
  await expect(bar(page).getByRole('button', { name: /^Numbered list/ })).toHaveAttribute('aria-pressed', 'true')
  await bar(page).getByRole('button', { name: /^Checklist/ }).click()
  await expect.poll(() => markdown(page, alias)).toBe('## Title\n\n- [ ] one\n')
  await bar(page).getByRole('button', { name: /^Bulleted list/ }).click()
  await expect.poll(() => markdown(page, alias)).toBe('## Title\n\n- one\n')
  await bar(page).getByRole('button', { name: /^Bulleted list/ }).click()
  await bar(page).getByRole('button', { name: /^Quote/ }).click()
  await expect.poll(() => markdown(page, alias)).toBe('## Title\n\n> one\n')
  await expect(bar(page).getByRole('button', { name: /^Quote/ })).toHaveAttribute('aria-pressed', 'true')
})

test('insert a table and an image', async ({ page }) => {
  const alias = await open(page, 'text\n')
  await page.getByTestId('editor').locator('.cm-line', { hasText: 'text' }).click()
  await bar(page).getByRole('button', { name: 'Insert table' }).click()
  await expect(page.getByTestId('editor').locator('.cm-lp-grid')).toHaveCount(1)
  await page.keyboard.type('Name')
  await expect.poll(() => markdown(page, alias)).toBe('text\n\n| Name | Column 2 |\n| --- | --- |\n|  |  |\n')

  await page.getByTestId('editor').locator('.cm-line', { hasText: 'text' }).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('End')
  const chooser = page.waitForEvent('filechooser')
  await bar(page).getByRole('button', { name: 'Insert image' }).click()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await (await chooser).setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png })
  await expect.poll(() => markdown(page, alias)).toMatch(/^text!\[dot\]\(\/[^)]+\)\n/)
})

test('the toolbar shows in the source editor too', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('greydoc-mode', 'edit'))
  await open(page, 'x\n')
  await expect(bar(page)).toBeVisible()
})

const oidc = 'http://127.0.0.1:3996'
async function signIn(browser: Browser, user: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: oidc })
  const page = await ctx.newPage()
  await page.goto('http://127.0.0.1:3997/as/' + user)
  await page.goto('/auth/login?next=/')
  await expect(page).toHaveURL(oidc + '/')
  return page
}

test('a commenter gets no toolbar but keeps Comment and Suggest', async ({ browser }) => {
  const bob = await signIn(browser, 'bob')
  const alice = await signIn(browser, 'alice')
  const alias = (await (await bob.request.post('/api/notes', { data: { content: 'Please review this.\n' } })).json()).alias
  await bob.request.put(`/api/notes/${alias}/permissions/users/alice`, { data: { level: 'comment' } })
  await bob.goto('/n/' + alias)
  await expect(bar(bob)).toBeVisible()
  await alice.goto('/n/' + alias)
  await expect(alice.getByTestId('editor').locator('.cm-content')).toBeVisible()
  await expect(bar(alice)).toHaveCount(0)
  await alice.getByTestId('editor').locator('.cm-line', { hasText: 'Please review' }).click()
  await alice.keyboard.press('End')
  await alice.keyboard.press('Shift+Home')
  await expect(alice.getByTestId('selection-toolbar').getByRole('button', { name: 'Comment' })).toBeVisible()
  await expect(alice.getByTestId('selection-toolbar').getByRole('button', { name: 'Suggest' })).toBeVisible()
})
