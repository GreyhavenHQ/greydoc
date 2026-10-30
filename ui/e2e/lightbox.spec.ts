import { expect, test, type Page } from '@playwright/test'

const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function screenshotPng(page: Page): Promise<Buffer> {
  await page.goto('/healthz')
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 2880
    c.height = 1800
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#dde'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.fillStyle = '#123'
    ctx.font = '40px sans-serif'
    for (let y = 60; y < c.height; y += 80) ctx.fillText('Screenshot text line ' + y, 40, y)
    return c.toDataURL('image/png').split(',')[1]
  })
  return Buffer.from(b64, 'base64')
}

async function upload(page: Page, alias: string, name: string, buffer: Buffer): Promise<string> {
  const up = await page.request.post(`/api/notes/${alias}/media`, { multipart: { file: { name, mimeType: 'image/png', buffer } } })
  expect(up.ok()).toBeTruthy()
  return (await up.json()).url
}

async function noteWithImages(page: Page, alias: string, body: (big: string, small: string) => string) {
  await page.request.post('/api/notes', { data: { content: '# Holder\n', alias: alias + '-holder' } })
  const big = await upload(page, alias + '-holder', 'shot.png', await screenshotPng(page))
  const small = await upload(page, alias + '-holder', 'icon.png', tiny)
  await page.request.post('/api/notes', { data: { content: body(big, small), alias } })
  return { big, small }
}

async function loaded(page: Page, selector: string) {
  const img = page.getByTestId('preview').locator(selector)
  await img.scrollIntoViewIfNeeded()
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
  return img
}

const scaleOf = (page: Page) =>
  page.getByTestId('lightbox-view').locator('> div').evaluate((el) => {
    const m = /scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)
    return m ? Number(m[1]) : 1
  })

test('a shrunk image opens in a lightbox with zoom, pan and close', async ({ page }) => {
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}.`).join('\n\n')
  const { big } = await noteWithImages(page, 'lightbox-table', (big) => `# Shots\n\n${filler}\n\n| Screen |\n|---|\n| ![wide shot](${big}) |\n`)
  await page.goto('/n/lightbox-table?view')
  const img = await loaded(page, 'td img')
  await img.hover()
  await expect(img).toHaveClass(/is-zoomable/)
  expect(await img.evaluate((el) => getComputedStyle(el).cursor)).toBe('zoom-in')
  expect(await img.evaluate((el) => el.parentElement!.children.length)).toBe(1)

  const yBefore = (await img.boundingBox())!.y
  await img.click()
  const box = page.getByTestId('lightbox')
  await expect(box).toBeVisible()
  const shown = page.getByTestId('lightbox-view').locator('img')
  await expect(shown).toHaveAttribute('src', big)
  const vp = page.viewportSize()!
  const fitted = (await shown.boundingBox())!
  expect(fitted.width).toBeLessThanOrEqual(vp.width)
  expect(fitted.height).toBeLessThanOrEqual(vp.height)

  // Wheel zooms around the pointer.
  const px = fitted.x + fitted.width * 0.3
  const py = fitted.y + fitted.height * 0.4
  await page.mouse.move(px, py)
  await page.mouse.wheel(0, -300)
  await expect.poll(() => scaleOf(page)).toBeGreaterThan(1)
  const zoomed = (await shown.boundingBox())!
  expect((px - zoomed.x) / zoomed.width).toBeCloseTo(0.3, 2)
  expect((py - zoomed.y) / zoomed.height).toBeCloseTo(0.4, 2)

  // Drag pans.
  await page.mouse.down()
  await page.mouse.move(px + 100, py + 50, { steps: 5 })
  await page.mouse.up()
  const panned = (await shown.boundingBox())!
  expect(panned.x - zoomed.x).toBeCloseTo(100, 0)
  await expect(box).toBeVisible()

  // Double-click switches between fitted and 100 %.
  await page.mouse.dblclick(vp.width / 2, vp.height / 2)
  await expect.poll(() => scaleOf(page)).toBe(1)
  await page.mouse.dblclick(vp.width / 2, vp.height / 2)
  await expect.poll(async () => Math.round((await shown.boundingBox())!.width)).toBe(2880)
  await page.mouse.dblclick(vp.width / 2, vp.height / 2)
  await expect.poll(() => scaleOf(page)).toBe(1)

  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
  expect((await img.boundingBox())!.y).toBe(yBefore)
  await expect(img).toBeInViewport()

  // A click on the background closes.
  await img.click()
  await expect(box).toBeVisible()
  await page.mouse.click(10, vp.height / 2)
  await expect(box).toHaveCount(0)

  // A drag from the image that ends on the background does not close.
  await img.click()
  await expect(box).toBeVisible()
  await page.mouse.move(vp.width / 2, vp.height / 2)
  await page.mouse.down()
  await page.mouse.move(10, vp.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(box).toBeVisible()

  await page.getByRole('button', { name: 'Close' }).click()
  await expect(box).toHaveCount(0)
})

test('the lightbox opens the original upload in a new tab', async ({ page }) => {
  const { big } = await noteWithImages(page, 'lightbox-original', (big) => `# Shots\n\n![wide shot](${big})\n`)
  await page.goto('/n/lightbox-original?view')
  const img = await loaded(page, 'img')
  await expect(img).toHaveAttribute('src', big + '?w=1600')
  await img.click()
  const [tab] = await Promise.all([page.context().waitForEvent('page'), page.getByRole('link', { name: 'Open original' }).click()])
  await tab.waitForLoadState()
  expect(new URL(tab.url()).pathname + new URL(tab.url()).search).toBe(big)
})

test('a linked image follows the link and an icon at its size does nothing', async ({ page }) => {
  await page.route('https://example.com/**', (r) => r.fulfill({ body: 'target', contentType: 'text/plain' }))
  await noteWithImages(page, 'lightbox-link', (big, small) => `# Shots\n\nIcon ![icon](${small}) here.\n\n[![logo](${big})](https://example.com/target)\n`)
  await page.goto('/n/lightbox-link?view')
  const icon = await loaded(page, 'img[alt=icon]')
  await icon.hover()
  await expect(icon).not.toHaveClass(/is-zoomable/)
  await icon.click()
  await expect(page.getByTestId('lightbox')).toHaveCount(0)

  const linked = await loaded(page, 'a img')
  await linked.hover()
  await expect(linked).not.toHaveClass(/is-zoomable/)
  await linked.click()
  await expect(page).toHaveURL('https://example.com/target')
})

test('a text selection that ends on an image does not open the lightbox', async ({ page }) => {
  await noteWithImages(page, 'lightbox-select', (big) => `# Shots\n\nSome words before\n\n![wide shot](${big})\n`)
  await page.goto('/n/lightbox-select?view')
  const img = await loaded(page, 'img')
  const words = page.getByTestId('preview').getByText('Some words before')
  const from = (await words.boundingBox())!
  const to = (await img.boundingBox())!
  await page.mouse.move(from.x + 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 })
  await page.mouse.up()
  expect(await page.evaluate(() => document.getSelection()!.isCollapsed)).toBe(false)
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
})

test('live mode keeps its click behaviour on images', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('greydoc-mode', 'live'))
  await noteWithImages(page, 'lightbox-live', (big) => `# Shots\n\n![wide shot](${big})\n`)
  await page.goto('/n/lightbox-live')
  const editor = page.getByTestId('editor')
  await expect(editor.locator('.cm-live')).toHaveCount(1)
  const img = editor.locator('img[alt="wide shot"]')
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  await img.click()
  await expect(page.getByTestId('lightbox')).toHaveCount(0)
})
