import { expect, test } from '@playwright/test'

test('create a folder, move two documents into it, trash and restore it', async ({ page }) => {
  await page.request.post('/api/notes', { data: { content: '# Folder plan', alias: 'folder-plan' } })
  await page.request.post('/api/notes', { data: { content: '# Folder notes', alias: 'folder-notes' } })

  await page.goto('/?scope=mine')
  await page.getByRole('button', { name: 'New folder' }).click()
  await page.getByLabel('Folder name').fill('Project X')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page).toHaveURL(/\/f\//)
  const folderURL = page.url()
  await expect(page.getByTestId('breadcrumb')).toContainText('Project X')

  await page.goto('/?scope=mine')
  const list = page.getByTestId('note-list')
  for (const title of ['Folder plan', 'Folder notes']) {
    const card = list.locator('li', { hasText: title })
    await card.hover()
    await card.getByRole('checkbox', { name: 'Select ' + title }).click()
  }
  await expect(page.getByTestId('selection-bar')).toContainText('2 selected')
  await page.getByTestId('selection-bar').getByRole('button', { name: 'Move', exact: true }).click()
  await page.getByTestId('move-targets').getByRole('button', { name: 'Project X' }).click()
  await expect(page.getByTestId('move-changes')).toContainText('Nobody gains or loses access.')
  await page.getByRole('button', { name: 'Move to Project X' }).click()
  await expect(page.getByText('Moved 2 items to Project X')).toBeVisible()
  await expect(list.locator('li', { hasText: 'Folder plan' })).toHaveCount(0)
  await expect(page.getByTestId('folder-list')).toContainText('Project X')

  await page.getByTestId('folder-list').getByRole('link', { name: 'Project X' }).click()
  await expect(page).toHaveURL(folderURL)
  await expect(list).toContainText('Folder plan')
  await expect(list).toContainText('Folder notes')

  await page.goto('/?scope=all')
  await expect(list.locator('li', { hasText: 'Folder plan' })).toContainText('Project X')
  await expect(page.getByRole('tab', { name: 'All documents' })).toHaveAttribute('aria-selected', 'true')

  await page.goto(folderURL)
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'Folder actions' }).click()
  await page.getByRole('menuitem', { name: 'Move to trash' }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.goto('/n/folder-plan')
  await expect(page.getByText('This document is in the trash.')).toBeVisible()

  await page.goto('/trash')
  await expect(page.getByTestId('trash-folders')).toContainText('Project X')
  await expect(page.getByTestId('trash-list')).not.toContainText('Folder plan')
  await page.getByTestId('trash-folders').getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByText('Restored', { exact: true })).toBeVisible()
  await page.goto(folderURL)
  await expect(list).toContainText('Folder plan')
})

test('a new document from a folder page is created in that folder', async ({ page }) => {
  const r = await page.request.post('/api/folders', { data: { name: 'Drafts' } })
  const id = (await r.json()).folder.id
  await page.goto('/f/' + id)
  await page.getByRole('button', { name: 'New document' }).first().click()
  await expect(page).toHaveURL(/\/n\//)
  const alias = page.url().split('/n/')[1]
  const list = await (await page.request.get('/api/notes?folder=' + id)).json()
  expect(list.notes.map((n: { alias: string }) => n.alias)).toContain(alias)
})

test('the home page opens on My documents, and Recent is a list by last opened', async ({ page }) => {
  await page.request.post('/api/notes', { data: { content: '# Opened once', alias: 'opened-once' } })
  await page.goto('/n/opened-once')
  await expect(page.getByTestId('preview').locator('h1')).toHaveText('Opened once')
  await page.goto('/')
  await expect(page.getByRole('tab', { name: 'Documents', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Recent' }).click()
  await expect(page).toHaveURL(/scope=recent/)
  await expect(page.getByText('Last opened')).toBeVisible()
  await expect(page.getByTestId('note-list').locator('li').first()).toContainText('Opened once')
})

test('long lists load 50 documents at a time as you scroll', async ({ page }) => {
  for (let i = 0; i < 120; i++) {
    await page.request.post('/api/notes', { data: { content: `---\ntags: [bulkpage]\n---\n# Bulk ${String(i).padStart(3, '0')}` } })
  }
  await page.goto('/?scope=all&tag=bulkpage')
  const rows = page.getByTestId('note-list').locator('li')
  await expect(rows).toHaveCount(50)
  await page.getByTestId('load-more').scrollIntoViewIfNeeded()
  await expect(rows).toHaveCount(100)
  await page.getByTestId('load-more').scrollIntoViewIfNeeded()
  await expect(rows).toHaveCount(120)
  await expect(page.getByTestId('list-end')).toHaveText('All 120 documents loaded.')
  await expect(page.getByTestId('load-more')).toHaveCount(0)
})

test('opening a folder swaps the list in one step, with no empty or placeholder state', async ({ page }) => {
  const r = await page.request.post('/api/folders', { data: { name: 'Steady' } })
  const id = (await r.json()).folder.id
  await page.request.post('/api/notes', { data: { content: '# Inside steady', folder: id } })
  await page.request.post('/api/notes', { data: { content: '---\ntags: [steady]\n---\n# Tagged at the top' } })
  await page.goto('/')
  await expect(page.getByTestId('folder-list')).toContainText('Steady')
  await expect(page.getByTestId('tag-filter')).toBeVisible()
  const listTop = async () => (await page.getByTestId('folder-list').or(page.getByTestId('note-list')).first().boundingBox())!.y
  const before = await listTop()
  await page.evaluate(() => {
    const w = window as unknown as { gaps: string[] }
    w.gaps = []
    new MutationObserver(() => {
      if (!document.querySelector('[data-testid="folder-list"], [data-testid="note-list"]')) w.gaps.push('list gone')
      if (document.querySelector('[data-slot="skeleton"]')) w.gaps.push('skeleton')
      if (document.querySelector('[data-testid="breadcrumb"]')?.textContent?.includes('…')) w.gaps.push('breadcrumb placeholder')
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  await page.getByTestId('folder-list').getByRole('link', { name: 'Steady' }).click()
  await expect(page.getByTestId('note-list')).toContainText('Inside steady')
  // The breadcrumb row and the tag row have the same height, so the list starts at the same place.
  expect(await listTop()).toBe(before)
  await page.getByTestId('breadcrumb').getByRole('link').first().click()
  await expect(page.getByTestId('folder-list')).toContainText('Steady')
  expect(await page.evaluate(() => (window as unknown as { gaps: string[] }).gaps)).toEqual([])
})

test('right-click or the row button opens the actions of a document or a folder', async ({ page }) => {
  const r = await page.request.post('/api/folders', { data: { name: 'Menu target' } })
  const id = (await r.json()).folder.id
  await page.request.post('/api/notes', { data: { content: '# Menu doc one', alias: 'menu-doc-one' } })
  await page.request.post('/api/notes', { data: { content: '# Menu doc two', alias: 'menu-doc-two' } })
  await page.goto('/')
  const menu = page.getByTestId('item-menu')

  await page.getByTestId('note-list').locator('li', { hasText: 'Menu doc one' }).click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Open', 'Open in a new tab', 'Duplicate', 'Unpin', 'Move…', 'Move to trash'].map((t) => (t === 'Unpin' ? /Pin|Unpin/ : t)))
  await menu.getByRole('menuitem', { name: 'Move…' }).click()
  await page.getByTestId('move-targets').getByRole('button', { name: 'Menu target' }).click()
  await page.getByRole('button', { name: 'Move to Menu target' }).click()
  await expect(page.getByText('Moved 1 item to Menu target')).toBeVisible()
  await expect(page.getByTestId('note-list').locator('li', { hasText: 'Menu doc one' })).toHaveCount(0)

  const folderRow = page.getByTestId('folder-list').locator('li', { hasText: 'Menu target' })
  await folderRow.hover()
  await folderRow.getByRole('button', { name: 'Actions for Menu target' }).click()
  await menu.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.getByLabel('Folder name').fill('Menu renamed')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('folder-list')).toContainText('Menu renamed')

  const two = page.getByTestId('note-list').locator('li', { hasText: 'Menu doc two' })
  await two.hover()
  await two.getByRole('checkbox').click()
  const renamed = page.getByTestId('folder-list').locator('li', { hasText: 'Menu renamed' })
  await renamed.hover()
  await renamed.getByRole('checkbox').click()
  await two.click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Move 2 items…', 'Move 2 items to trash'])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await page.request.post('/api/move', { data: { notes: ['menu-doc-two'], folders: [], to: id } })
})

test('the logo in a document leads back to its folder, and the item count shares the name baseline', async ({ page }) => {
  const r = await page.request.post('/api/folders', { data: { name: 'Way back' } })
  const id = (await r.json()).folder.id
  await page.request.post('/api/notes', { data: { content: '# Inside way back', alias: 'way-back-doc', folder: id } })
  await page.goto('/n/way-back-doc')
  await page.getByRole('link', { name: 'Back to Way back' }).click()
  await expect(page).toHaveURL('/f/' + id)
  await expect(page.getByTestId('breadcrumb')).toContainText('Way back')

  await page.goto('/')
  const row = page.getByTestId('folder-list').locator('li', { hasText: 'Way back' })
  // Text baseline = top of the box + the font ascent. Both spans report it with a zero-height inline-block probe.
  const baselines = await row.evaluate((li) => {
    const probe = (el: Element) => {
      const p = document.createElement('span')
      p.style.display = 'inline-block'
      el.appendChild(p)
      const y = p.getBoundingClientRect().bottom
      p.remove()
      return y
    }
    const name = li.querySelector('a span span.font-medium')!
    const count = li.querySelector('[data-testid="folder-count"]')!
    return [probe(name), probe(count)]
  })
  expect(Math.abs(baselines[0] - baselines[1])).toBeLessThan(0.5)
})
