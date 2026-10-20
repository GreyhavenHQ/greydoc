import { expect, test, type Page } from '@playwright/test'

async function noteWith(page: Page, text: string): Promise<string> {
  const resp = await page.request.post('/api/notes', { data: { content: text } })
  expect(resp.status()).toBe(201)
  return (await resp.json()).alias
}

async function openInPreview(page: Page, alias: string) {
  await page.goto('/n/' + alias + '?view')
  await expect(page.getByTitle('Connected')).toBeVisible()
  await expect(page.getByTestId('connecting')).toHaveCount(0)
}

// selectInPreview selects the first occurrence of needle in the rendered text, or the contents of a selector.
async function selectInPreview(page: Page, needle: string, selector?: string) {
  await page.getByTestId('preview').evaluate(
    (root, [needle, selector]) => {
      const r = document.createRange()
      if (selector) r.selectNodeContents(root.querySelector(selector)!)
      else {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        const nodes: Text[] = []
        for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
        const at = nodes.map((n) => n.data).join('').indexOf(needle!)
        const point = (pos: number, end: boolean): [Text, number] => {
          let acc = 0
          for (const n of nodes) {
            if (pos < acc + n.length || (end && pos === acc + n.length)) return [n, pos - acc]
            acc += n.length
          }
          throw new Error('out of range')
        }
        r.setStart(...point(at, false))
        r.setEnd(...point(at + needle!.length, true))
      }
      const sel = document.getSelection()!
      sel.removeAllRanges()
      sel.addRange(r)
    },
    [needle, selector],
  )
}

const joined = (page: Page, selector: string) => async () => (await page.locator(selector).allTextContents()).join('')

async function comment(page: Page, body: string) {
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'Comment' }).click()
  await page.getByTestId('comment-input').fill(body)
  await page.getByTestId('comments-panel').getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(page.getByTestId('thread')).toContainText(body)
}

test('comment on rendered text in preview-only mode', async ({ page }) => {
  const alias = await noteWith(page, 'The **budget** is final.\n')
  await openInPreview(page, alias)
  await selectInPreview(page, 'budget is final')
  const toolbar = page.getByTestId('selection-toolbar')
  await expect(toolbar.getByRole('button', { name: 'Comment' })).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'Suggest' })).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'AI' })).toHaveCount(0)
  await comment(page, 'Is it?')
  await expect(page.getByTestId('thread')).toContainText('budget** is final')
  await expect.poll(joined(page, '.preview-thread')).toBe('budget is final')
  await page.keyboard.press('Control+Alt+KeyB')
  await expect.poll(joined(page, '.cm-thread')).toBe('budget** is final')
  await expect(page.locator('.preview-thread')).toHaveCount(0)
})

test('a comment on rendered math covers the whole block', async ({ page }) => {
  const alias = await noteWith(page, 'Before.\n\n$$\n\\frac{a}{b}\n$$\n\nAfter.\n')
  await openInPreview(page, alias)
  await selectInPreview(page, '', '.katex-display')
  await comment(page, 'Check the formula')
  await expect(page.getByTestId('thread').locator('blockquote')).toHaveText('\\frac{a}{b}')
  await expect(page.locator('.preview-thread-block')).toHaveCount(1)
  await expect(page.locator('.preview-thread-block')).toHaveClass(/katex-block/)
  await page.keyboard.press('Control+Alt+KeyB')
  await expect.poll(joined(page, '.cm-thread')).toBe('$$\\frac{a}{b}$$')
})

test('a suggestion from the preview becomes a tracked change', async ({ page }) => {
  const alias = await noteWith(page, 'The plan is bad.\n')
  await openInPreview(page, alias)
  await selectInPreview(page, 'bad')
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'Suggest' }).click()
  await expect(page.getByTestId('suggest-input')).toHaveValue('bad')
  await page.getByTestId('suggest-input').fill('good')
  await page.getByTestId('suggest-composer').getByRole('button', { name: 'Suggest' }).click()
  await expect(page.getByTestId('suggest-composer')).toHaveCount(0)
  await page.keyboard.press('Control+Alt+KeyB')
  await expect(page.locator('.cm-sugg-del')).toHaveText('bad')
  await expect(page.locator('.cm-sugg-ins .cm-sugg-text')).toHaveText('good')
  await page.getByRole('button', { name: 'Accept suggestion' }).click()
  await expect(page.getByTestId('preview')).toHaveText('The plan is good.')
})

test('a read-only reader gets no toolbar in the preview', async ({ page }) => {
  const alias = await noteWith(page, 'Read only text.\n')
  // Local mode gives everyone full access. The test lowers the level the page receives.
  await page.route(`**/api/notes/${alias}?visit=1*`, async (route) => {
    const resp = await route.fetch()
    await route.fulfill({ response: resp, json: { ...(await resp.json()), level: 'read' } })
  })
  await page.routeWebSocket(/\/ws\//, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      if (typeof m !== 'string') {
        const s = m.toString('latin1')
        if (s.includes('"type":"access"')) m = Buffer.from(s.replace('"level":"full"', '"level":"read"'), 'latin1')
      }
      ws.send(m)
    })
  })
  await page.goto('/n/' + alias)
  await expect(page.getByText('Read only', { exact: true })).toBeVisible()
  await expect(page.getByTitle('Connected')).toBeVisible()
  await selectInPreview(page, 'only')
  await page.waitForTimeout(300)
  await expect(page.getByTestId('selection-toolbar')).toHaveCount(0)
})

test('a preview highlight opens its thread, and resolving removes it', async ({ page }) => {
  const alias = await noteWith(page, 'The budget is final.\n')
  await openInPreview(page, alias)
  await selectInPreview(page, 'final')
  await comment(page, 'Sure?')
  await page.getByRole('button', { name: 'Close comments' }).click()
  await expect(page.locator('.preview-thread-active')).toHaveCount(0)
  await page.locator('.preview-thread').click()
  await expect(page.getByTestId('comments-panel')).toBeVisible()
  await expect(page.locator('.preview-thread-active')).toHaveText('final')
  await page.getByTestId('thread').getByRole('button', { name: 'Resolve' }).click()
  await expect(page.getByTestId('thread')).toHaveCount(0)
  await expect(page.locator('.preview-thread')).toHaveCount(0)
})

test('selecting a thread in the panel scrolls the preview to it', async ({ page }) => {
  const filler = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.`).join('\n\n')
  const alias = await noteWith(page, filler + '\n\nTarget words here.\n')
  await openInPreview(page, alias)
  await selectInPreview(page, 'Target words')
  await comment(page, 'Look')
  await page.getByTestId('preview').evaluate((el) => el.closest('section')!.scrollTo({ top: 0 }))
  await expect(page.locator('.preview-thread').first()).not.toBeInViewport()
  await page.getByTestId('thread').locator('blockquote').click()
  await expect(page.locator('.preview-thread').first()).toBeInViewport()
})

test('a highlight follows edits by another user and keeps task boxes working', async ({ browser }) => {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  const alias = await noteWith(a, '- [ ] write the plan\n')
  await openInPreview(a, alias)
  await selectInPreview(a, 'the plan')
  await comment(a, 'Which plan?')
  await expect.poll(joined(a, '.preview-thread')).toBe('the plan')

  const ctxB = await browser.newContext()
  await ctxB.addInitScript(() => localStorage.setItem('greydoc-mode', 'both'))
  const b = await ctxB.newPage()
  await b.goto('/n/' + alias)
  await b.locator('[data-testid=editor] .cm-content').click()
  await b.keyboard.press('ControlOrMeta+End')
  await b.keyboard.type('\nNew first line?')
  await b.keyboard.press('ControlOrMeta+Home')
  await b.keyboard.type('Intro.\n\n')
  await expect(a.getByTestId('preview')).toContainText('Intro.')
  await expect(a.getByTestId('preview')).toContainText('New first line?')
  await expect.poll(joined(a, '.preview-thread')).toBe('the plan')

  await a.getByTestId('preview').locator('input[type=checkbox]').click()
  await expect.poll(async () => (await a.request.get(`/api/notes/${alias}/content`)).text()).toContain('- [x] write the plan')
  await expect.poll(joined(a, '.preview-thread')).toBe('the plan')
})
