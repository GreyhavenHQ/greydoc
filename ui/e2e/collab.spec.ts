import { expect, test, type Page } from '@playwright/test'

// These tests read the preview pane, so they use the split view.
const splitView = () => localStorage.setItem('greydoc-mode', 'both')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(splitView)
})

async function typeInEditor(page: Page, text: string) {
  await page.locator('[data-testid=editor] .cm-content').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
}

test('new note opens an editor ready for typing', async ({ page }) => {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\/[a-z0-9]+$/)
  await expect(page.locator('[data-testid=editor] .cm-content')).toBeFocused()
  await page.keyboard.type('# Hello greydoc')
  await expect(page.getByTestId('note-title')).toHaveText('Hello greydoc')
  await expect(page.getByTestId('preview').locator('h1')).toHaveText('Hello greydoc')
})

test('two browsers editing one note converge and see each other', async ({ browser }) => {
  const ctxA = await browser.newContext()
  await ctxA.addInitScript(splitView)
  const a = await ctxA.newPage()
  await a.goto('/new')
  await expect(a).toHaveURL(/\/n\/[a-z0-9]+$/)
  const url = a.url()
  await typeInEditor(a, 'from A.')

  const ctxB = await browser.newContext()
  await ctxB.addInitScript(splitView)
  const b = await ctxB.newPage()
  await b.goto(url)
  await expect(b.locator('[data-testid=editor] .cm-content')).toContainText('from A.')
  await typeInEditor(b, ' from B.')

  await expect(a.getByTestId('preview')).toHaveText('from A. from B.')
  await expect(b.getByTestId('preview')).toHaveText('from A. from B.')
  await expect(a.getByTestId('presence').locator('span')).toHaveCount(2)
  await expect(a.locator('.cm-ySelectionCaret')).toHaveCount(1)
})

test('home lists notes and filters by tag', async ({ page }) => {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\//)
  await typeInEditor(page, '---\ntags: [design, q4]\n---\n# Tagged note')
  await page.waitForTimeout(600)
  await page.goto('/?scope=all')
  await expect(page.getByTestId('note-list')).toContainText('Tagged note')
  await page.getByTestId('tag-filter').getByRole('button', { name: /^q4/ }).click()
  await expect(page.getByTestId('note-list').locator('li')).toHaveCount(1)
})

test('mermaid diagrams render with tools', async ({ page }) => {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\//)
  await page.keyboard.type('```mermaid\ngraph TD\nA[Start] --> B[End]\n')
  const block = page.getByTestId('preview').locator('.mermaid-block')
  await expect(block.locator('svg').first()).toBeVisible({ timeout: 15_000 })
  await expect(block.locator('.mermaid-toolbar button')).toHaveCount(6)
  await expect(block.locator('svg').first()).toContainText('Start')
})

test('timeline and author layer', async ({ page }) => {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\//)
  await page.keyboard.type('Written by me')
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Who wrote what' }).click()
  await expect(page.locator('.cm-author')).toHaveCount(1)
  await expect(page.getByTestId('authors-legend')).toContainText('Anonymous')
  await page.getByRole('button', { name: 'Timeline' }).click()
  await expect(page.getByTestId('timeline')).toContainText('created the note')
  await expect(page.getByText(/Editing now/)).toBeVisible()
})

test('comment on a selection, reply and resolve', async ({ page }) => {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\//)
  await page.keyboard.type('The budget is final.')
  await page.keyboard.press('Shift+Home')
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'Comment' }).click()
  await page.getByTestId('comment-input').fill('Is it?')
  await page.getByTestId('comments-panel').getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(page.getByTestId('thread')).toContainText('Is it?')
  await expect(page.locator('.cm-thread')).toHaveCount(1)
  await page.getByTestId('thread').getByPlaceholder('Reply').fill('Yes')
  await page.getByTestId('thread').getByRole('button', { name: 'Reply' }).click()
  await expect(page.getByTestId('thread')).toContainText('Yes')
  await page.getByTestId('thread').getByRole('button', { name: 'Resolve' }).click()
  await expect(page.getByTestId('thread')).toHaveCount(0)
  await expect(page.locator('.cm-thread')).toHaveCount(0)
})

test('a suggestion from the selection toolbar becomes a tracked change', async ({ page }) => {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\//)
  await page.keyboard.type('The plan is bad.')
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft')
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'Suggest' }).click()
  await page.getByTestId('suggest-input').fill('good')
  await page.getByTestId('suggest-composer').getByRole('button', { name: 'Suggest' }).click()
  await expect(page.locator('.cm-sugg-del')).toHaveText('bad')
  await expect(page.locator('.cm-sugg-ins .cm-sugg-text')).toHaveText('good')
  await expect(page.getByTestId('preview')).toHaveText('The plan is bad.')
  await page.getByRole('button', { name: 'Accept suggestion' }).click()
  await expect(page.getByTestId('preview')).toHaveText('The plan is good.')
  await expect(page.locator('.cm-sugg-ins')).toHaveCount(0)
})

test('AI refine becomes an AI-assisted suggestion', async ({ page }) => {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\//)
  await page.keyboard.type('the meeting was good i think')
  await page.keyboard.press('Shift+Home')
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'AI' }).click()
  await page.getByRole('menuitem', { name: 'Refine' }).click()
  await expect(page.locator('.cm-sugg-ins.cm-sugg-ai_assisted .cm-sugg-text')).toHaveText('The meeting went well.')
  await expect(page.getByTestId('preview')).toHaveText('the meeting was good i think')
  await page.getByRole('button', { name: 'Accept suggestion' }).click()
  await expect(page.getByTestId('preview')).toHaveText('The meeting went well.')
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Who wrote what' }).click()
  await expect.poll(async () => (await page.locator('.cm-author-ai').allTextContents()).join('')).toBe('The meeting went well.')
  await expect(page.getByTestId('authors-legend')).toContainText('AI-assisted')
})

async function noteWith(page: Page, text: string): Promise<string> {
  const resp = await page.request.post('/api/notes', { data: { content: text } })
  expect(resp.status()).toBe(201)
  return (await resp.json()).alias
}

test('view-only page shows the note and nothing else', async ({ page }) => {
  const alias = await noteWith(page, '# For the client\n\nResults are in.')
  await page.goto('/s/' + alias)
  await expect(page.getByTestId('view-page').locator('h1')).toHaveText('For the client')
  await expect(page.locator('[data-testid=editor]')).toHaveCount(0)
  await expect(page.getByRole('button')).toHaveCount(0)
  await expect(page.locator('header')).toHaveCount(0)
})

test('a short view-only link opens the note', async ({ page }) => {
  const alias = await noteWith(page, '# Short link\n\nFor a client.')
  const r = await page.request.post(`/api/notes/${alias}/share-links`, { data: { label: 'client' } })
  const { url, link } = await r.json()
  expect(url).toMatch(/\/v\/[A-Za-z0-9_-]{16}$/)
  await page.goto(new URL(url).pathname)
  await expect(page.getByTestId('view-page').locator('h1')).toHaveText('Short link')
  await page.request.delete(`/api/notes/${alias}/share-links/${link.id}`)
  await page.reload()
  await expect(page.getByText('This link does not exist or was revoked.')).toBeVisible()
})

test('slide mode splits on ---', async ({ page }) => {
  const alias = await noteWith(page, '# One\n\n---\n\n# Two\n\n----\n\n## Two down\n')
  await page.goto('/p/' + alias)
  await expect(page.locator('.reveal .slides > section')).toHaveCount(2)
  await expect(page.locator('.reveal .slides > section').first()).toContainText('One')
})

test('HTML download is standalone with rendered diagrams', async ({ page }) => {
  const alias = await noteWith(page, '# Export\n\n```mermaid\ngraph LR\nA-->B\n```\n')
  const downloading = page.waitForEvent('download')
  await page.goto('/s/' + alias + '?export=html')
  const file = await downloading
  expect(file.suggestedFilename()).toBe('export.html')
  const fs = await import('node:fs/promises')
  const html = await fs.readFile((await file.path())!, 'utf8')
  expect(html.slice(html.indexOf('<article'))).toContain('<svg')
  expect(html).toContain('<h1')
  expect(html).not.toMatch(/<script/i)
  expect(html.slice(html.indexOf('<article'))).not.toContain('mermaid-toolbar')
})

test('markdown download', async ({ page }) => {
  const alias = await noteWith(page, '# Plain\ntext')
  const resp = await page.request.get(`/api/notes/${alias}/download.md`)
  expect(await resp.text()).toBe('# Plain\ntext')
})

test('every common diagram type renders', async ({ page }) => {
  const kinds = [
    'flowchart LR\nA --> B',
    'sequenceDiagram\nA->>B: hi',
    'mindmap\n  root((x))\n    a\n    b',
    'stateDiagram-v2\n[*] --> S',
    'pie title P\n"a" : 1\n"b" : 2',
  ]
  const alias = await noteWith(page, kinds.map((k) => '```mermaid\n' + k + '\n```').join('\n\n'))
  await page.goto('/s/' + alias)
  const blocks = page.locator('.mermaid-block')
  await expect(blocks).toHaveCount(kinds.length)
  for (let i = 0; i < kinds.length; i++) await expect(blocks.nth(i).locator('svg').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.mermaid-error')).toHaveCount(0)
})

test('the home page shows one uncut row of tags and lists all of them on demand', async ({ page }) => {
  const tags = Array.from({ length: 60 }, (_, i) => `topic-${i}`)
  await page.request.post('/api/notes', { data: { content: `---\ntags: [${tags.join(', ')}]\n---\n# Many tags` } })
  await page.goto('/?scope=all')
  const filter = page.getByTestId('tag-filter')
  await expect(filter.getByRole('button').first()).toBeVisible()
  const row = (await filter.boundingBox())!
  const chips = await filter.getByRole('button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })))
  for (const c of chips) {
    const inside = c.top >= row.y - 0.5 && c.bottom <= row.y + row.height + 0.5
    const below = c.top >= row.y + row.height
    expect(inside || below).toBe(true)
  }
  await page.getByRole('button', { name: /^All \d+ tags$/ }).click()
  const list = page.getByTestId('tag-list')
  await list.getByPlaceholder('Filter tags').fill('topic-59')
  await expect(list.getByRole('button')).toHaveCount(1)
  await list.getByRole('button', { name: /topic-59/ }).click()
  await expect(page).toHaveURL(/tag=topic-59/)
  await expect(filter.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true')
})

test('task boxes in the preview change the text', async ({ page }) => {
  const resp = await page.request.post('/api/notes', { data: { content: '# Todo\n\n- [ ] write\n- [x] read\n' } })
  const alias = (await resp.json()).alias
  await page.goto('/n/' + alias)
  const boxes = page.getByTestId('preview').locator('input[type=checkbox]')
  await expect(boxes).toHaveCount(2)
  await boxes.first().click()
  await expect(boxes.first()).toBeChecked()
  await boxes.nth(1).click()
  await expect(boxes.nth(1)).not.toBeChecked()
  await expect.poll(async () => (await page.request.get(`/api/notes/${alias}/content`)).text()).toBe('# Todo\n\n- [x] write\n- [ ] read\n')
})

test('task boxes are read-only on the view page', async ({ page }) => {
  const resp = await page.request.post('/api/notes', { data: { content: '- [ ] write\n' } })
  const alias = (await resp.json()).alias
  await page.goto('/s/' + alias)
  await expect(page.getByTestId('view-page').locator('input[type=checkbox]')).toBeDisabled()
})

test('the help dialog renders Markdown examples', async ({ page }) => {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\//)
  await page.getByRole('button', { name: 'Account' }).click()
  await page.getByRole('menuitem', { name: 'Markdown help' }).click()
  const help = page.getByTestId('syntax-help')
  await expect(help.locator('.markdown-body h1').first()).toHaveText('Title')
  await help.getByRole('tab', { name: 'Blocks' }).click()
  await expect(help.locator('.mermaid-block svg').first()).toBeVisible({ timeout: 15_000 })
  await help.getByRole('tab', { name: 'Shortcuts' }).click()
  await expect(help).toContainText('Live mode')
})

test('the MCP setup shows opencode first, with Claude Code in its own tab', async ({ page }) => {
  await page.goto('/settings')
  const setup = page.getByTestId('mcp-setup')
  await expect(setup.getByRole('tab')).toHaveText(['opencode', 'Claude Code', 'Other clients'])
  await expect(setup.getByRole('tab', { name: 'opencode' })).toHaveAttribute('aria-selected', 'true')
  await expect(setup).toContainText('opencode.json')
  await setup.getByRole('tab', { name: 'Claude Code' }).click()
  await expect(setup.locator('input').first()).toHaveValue(/^claude mcp add --transport http greydoc http/)
})

test('the account menu has Markdown help and the theme switch, the note menu has who wrote what', async ({ page }) => {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\//)
  await page.keyboard.type('Hello there.')
  await expect(page.getByRole('button', { name: 'Show authors' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Markdown help' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Toggle theme' })).toHaveCount(0)
  const dark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
  const before = await dark()
  await page.getByRole('button', { name: 'Account' }).click()
  await page.getByRole('menuitem', { name: before ? 'Light mode' : 'Dark mode' }).click()
  await expect.poll(dark).toBe(!before)
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Who wrote what' }).click()
  await expect(page.getByTestId('authors-legend')).toBeVisible()
})

test('a refused connection stops the retries and says why', async ({ page }) => {
  const alias = await noteWith(page, '# Gone soon')
  let attempts = 0
  await page.routeWebSocket(/\/ws\//, (ws) => {
    attempts++
    ws.close({ code: 4410, reason: 'this note is in the trash' })
  })
  await page.goto('/n/' + alias)
  await expect(page.getByText('This note is in the trash.')).toBeVisible()
  await page.waitForTimeout(3000)
  expect(attempts).toBe(1)
})
