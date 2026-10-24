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

test('shared with me lists signed-in documents and only the top shared folder', async ({ browser }) => {
  const id = Date.now().toString(36)
  const alice = await signIn(browser, 'alice')
  const bob = await signIn(browser, 'bob')
  const folder = async (name: string, parent = '') =>
    (await (await alice.request.post('/api/folders', { data: { name, parent } })).json()).folder.id as string
  const note = async (title: string) =>
    (await (await alice.request.post('/api/notes', { data: { content: `# ${title}\n` } })).json()).alias as string

  const project = await folder(`Project ${id}`)
  const specs = await folder(`Specs ${id}`, project)
  for (const f of [project, specs]) await alice.request.put(`/api/folders/${f}/permissions/users/bob`, { data: { level: 'read' } })
  await alice.request.put(`/api/folders/${specs}/permissions/groups/_signed_in`, { data: { level: 'read' } })
  const open = await note(`Open ${id}`)
  await alice.request.put(`/api/notes/${open}/permissions/groups/_signed_in`, { data: { level: 'write' } })
  const inside = await note(`Inside ${id}`)
  await alice.request.post('/api/move', { data: { notes: [inside], folders: [], to: project } })
  await alice.request.put(`/api/notes/${inside}/permissions/users/bob`, { data: { level: 'write' } })

  await bob.goto('/?scope=shared')
  const folders = bob.getByTestId('folder-list')
  const notes = bob.getByTestId('note-list')
  await expect(notes).toContainText(`Open ${id}`)
  await expect(notes).not.toContainText(`Inside ${id}`)
  await expect(folders).toContainText(`Project ${id}`)
  await expect(folders).not.toContainText(`Specs ${id}`)

  await folders.getByRole('link', { name: `Project ${id}` }).click()
  await expect(bob.getByTestId('folder-list')).toContainText(`Specs ${id}`)
  await expect(bob.getByTestId('note-list')).toContainText(`Inside ${id}`)
})
