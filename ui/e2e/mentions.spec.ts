import { expect, test, type Browser, type Page } from '@playwright/test'

// These tests use the greydoc with OIDC that e2e/fake-idp.mjs starts.
const base = 'http://127.0.0.1:3996'

async function signIn(browser: Browser, user: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: base })
  const page = await ctx.newPage()
  await page.goto('http://127.0.0.1:3997/as/' + user)
  await page.goto('/auth/login?next=/')
  await expect(page).toHaveURL(base + '/')
  return page
}

async function newNote(page: Page, text: string): Promise<string> {
  await page.goto('/new')
  await expect(page).toHaveURL(/\/n\/[a-z0-9]+$/)
  await expect(page.locator('[data-testid=editor] .cm-content')).toBeFocused()
  await page.keyboard.type(text)
  return new URL(page.url()).pathname.split('/').pop()!
}

const unread = async (page: Page) => (await (await page.request.get('/api/notifications')).json()).unread as number

async function people(browser: Browser) {
  const alice = await signIn(browser, 'alice')
  const carol = await signIn(browser, 'carol')
  const bob = await signIn(browser, 'bob')
  return { alice, bob, carol }
}

test('a mention in the text notifies once when the revision closes, and Esc keeps plain text', async ({ browser }) => {
  const { alice, bob } = await people(browser)
  const before = await unread(alice)
  const alias = await newNote(bob, 'Hi ')
  await bob.request.put(`/api/notes/${alias}/permissions/users/alice`, { data: { level: 'comment' } })
  await bob.keyboard.type('@ali')
  // A click picks at once. Enter is ignored for 75 ms after the list opens (CodeMirror interactionDelay).
  await bob.locator('.cm-tooltip-autocomplete li', { hasText: 'Alice Martin' }).click()
  await expect(bob.locator('.cm-content .mention')).toHaveText('@Alice Martin')

  await bob.keyboard.type('and @ali')
  await expect(bob.locator('.cm-tooltip-autocomplete')).toBeVisible()
  await bob.keyboard.press('Escape')
  await expect(bob.locator('.cm-tooltip-autocomplete')).toHaveCount(0)
  await expect(bob.locator('.cm-content')).toContainText('and @ali')
  await expect(bob.locator('.cm-content .mention')).toHaveCount(1)

  await expect.poll(async () => (await bob.request.get(`/api/notes/${alias}/download.md`)).text()).toContain('Hi [@Alice Martin](@alice) and @ali')
  // Closing the last editor closes the revision at once.
  await bob.close()
  await expect.poll(() => unread(alice), { timeout: 15_000 }).toBe(before + 1)
  await alice.reload()
  await expect(alice.getByTestId('notification-count')).toHaveText(String(before + 1))
  await alice.getByTestId('notification-bell').click()
  await expect(alice.getByTestId('notification').first()).toContainText('Bob mentioned you in')
  await expect(alice.getByTestId('notification').first()).toHaveAttribute('href', `/n/${alias}?mention=1`)
})

test('a mention in a comment notifies at once and opens the thread', async ({ browser }) => {
  const { alice, bob } = await people(browser)
  const before = await unread(alice)
  const alias = await newNote(bob, 'Please review this.')
  await bob.request.put(`/api/notes/${alias}/permissions/users/alice`, { data: { level: 'comment' } })
  await bob.keyboard.press('Shift+Home')
  await bob.getByTestId('editor').locator('.cm-content').click({ button: 'right' })
  await bob.getByTestId('selection-toolbar').getByRole('button', { name: 'Comment' }).click()
  await bob.getByTestId('comment-input').pressSequentially('@Ali')
  await expect(bob.getByTestId('mention-picker')).toContainText('Alice Martin')
  await bob.keyboard.press('Enter')
  await bob.getByTestId('comment-input').pressSequentially('can you check?')
  await expect(bob.getByTestId('comment-input')).toHaveValue('[@Alice Martin](@alice) can you check?')
  await bob.getByTestId('comments-panel').getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(bob.getByTestId('thread').locator('.mention')).toHaveText('@Alice Martin')

  await expect.poll(() => unread(alice)).toBe(before + 1)
  await alice.reload()
  await alice.getByTestId('notification-bell').click()
  await alice.getByTestId('notification').first().click()
  await expect(alice).toHaveURL(new RegExp(`/n/${alias}`))
  await expect(alice.getByTestId('comments-panel')).toBeVisible()
  await expect(alice.getByTestId('thread')).toHaveClass(/border-primary/)
})

test('a person without access is marked and is not notified', async ({ browser }) => {
  const { bob, carol } = await people(browser)
  const before = await unread(carol)
  await newNote(bob, 'Secret plan.')
  await bob.keyboard.press('Shift+Home')
  await bob.getByTestId('editor').locator('.cm-content').click({ button: 'right' })
  await bob.getByTestId('selection-toolbar').getByRole('button', { name: 'Comment' }).click()
  await bob.getByTestId('comment-input').pressSequentially('@car')
  await expect(bob.getByTestId('mention-picker')).toContainText('no access')
  await bob.keyboard.press('Enter')
  await expect(bob.getByText('Carol cannot open this document.')).toBeVisible()
  await expect(bob.getByRole('button', { name: 'Give comment access' })).toBeVisible()
  await bob.getByTestId('comments-panel').getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(bob.getByTestId('thread')).toHaveCount(1)
  expect(await unread(carol)).toBe(before)
})

test('local mode has no bell and no @ picker', async ({ page }) => {
  await page.goto('http://127.0.0.1:3999/new')
  await expect(page).toHaveURL(/\/n\//)
  await page.keyboard.type('Hi @lo')
  await page.waitForTimeout(400)
  await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0)
  await expect(page.getByTestId('notification-bell')).toHaveCount(0)
})
