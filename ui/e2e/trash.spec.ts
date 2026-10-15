import { expect, test } from '@playwright/test'

test('trash, restore and audit', async ({ page }) => {
  const resp = await page.request.post('/api/notes', { data: { content: '# Old plan\n\ntext' } })
  const alias = (await resp.json()).alias
  await page.goto('/n/' + alias)
  await page.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Move to trash' }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('Moved to the trash', { exact: true })).toBeVisible()

  await page.goto('/n/' + alias)
  await expect(page.getByText('This document is in the trash.')).toBeVisible()

  await page.goto('/audit')
  const trashed = page.getByTestId('audit-event').filter({ hasText: 'moved the document to the trash' })
  await expect(trashed).toContainText('Old plan')
  await expect(trashed).toContainText('in trash')

  await page.goto('/trash')
  await expect(page.getByTestId('trash-list')).toContainText('Old plan')
  await page.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByText('Restored', { exact: true })).toBeVisible()
  await page.goto('/n/' + alias)
  await expect(page.getByTestId('preview').locator('h1')).toHaveText('Old plan')

  await page.goto('/audit')
  await expect(page.getByTestId('audit-event').first()).toContainText('restored the document from the trash')
})

test('agent calls appear in the audit log with a usage summary', async ({ page, request }) => {
  const alias = (await (await request.post('/api/notes', { data: { content: '# Watched\nx' } })).json()).alias
  const rpc = async (body: object, session?: string) => {
    const headers: Record<string, string> = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
    if (session) headers['Mcp-Session-Id'] = session
    return request.post('/mcp', { headers, data: body })
  }
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-agent', version: '1' } } })
  const session = init.headers()['mcp-session-id']
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)
  await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_note', arguments: { note: alias } } }, session)

  await page.goto('/audit?kind=mcp')
  await expect(page.getByTestId('mcp-usage')).toContainText('read_note')
  await expect(page.getByTestId('mcp-usage')).toContainText('e2e-agent')
  await expect(page.getByTestId('audit-event').filter({ hasText: 'called read_note' })).toContainText('Watched')
  await expect(page.getByTestId('audit-event').filter({ hasText: 'opened an MCP session' })).toContainText('e2e-agent')
})

test('in local mode the sign-in page goes straight on', async ({ page }) => {
  await page.goto('/login?next=/settings')
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByTestId('sign-in')).toHaveCount(0)
})
