import { expect, test, type Page } from '@playwright/test'

const long = 'This cell holds a long text that wraps over several lines in the preview, so the rows of the table have unequal heights.'

// The source line of each marker is its index in this array. Every block has a marker that the preview shows.
function acceptanceDoc(): { text: string; markers: Map<string, number> } {
  const lines: string[] = ['# Scroll sync', '', '| Row | Text |', '|---|---|']
  for (let i = 1; i <= 60; i++) lines.push(`| R${i} | ${i % 3 === 0 ? long + ' ' + long : 'short'} |`)
  lines.push('', '```mermaid', 'flowchart TD')
  for (let i = 0; i < 14; i++) lines.push(`  N${i}[Step ${i}] --> N${i + 1}[Step ${i + 1}]`)
  lines.push('```', '')
  for (let i = 1; i <= 40; i++) lines.push(`Paragraph P${i} end.`, '')
  const markers = new Map<string, number>()
  lines.forEach((l, i) => {
    const m = /^\| (R\d+) \||^Paragraph (P\d+) end\.$/.exec(l)
    if (m) markers.set(m[1] ?? m[2], i)
  })
  return { text: lines.join('\n'), markers }
}

async function open(page: Page, content: string, mode = 'both') {
  await page.setViewportSize({ width: 1280, height: 800 })
  const alias = (await (await page.request.post('/api/notes', { data: { content } })).json()).alias
  await page.goto(`/n/${alias}?${mode}`)
  await expect(page.locator('.cm-content')).toBeVisible()
  return alias
}

// scrollEditorTo puts the zero-based source line at the top of the editor, by the line numbers in the gutter.
async function scrollEditorTo(page: Page, line: number) {
  await page.locator('.cm-editor').hover()
  await page.evaluate(async (n) => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    for (let i = 0; i < 50; i++) {
      const cells = Array.from(document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')).filter((c) => c.textContent)
      const cell = cells.find((c) => Number(c.textContent) === n + 1)
      if (cell) {
        const d = cell.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        const before = scroller.scrollTop
        if (Math.abs(d) < 1) return
        scroller.scrollTop += d
        if (scroller.scrollTop === before) return
      } else {
        const first = Number(cells.find((c) => c.getBoundingClientRect().height > 0)?.textContent ?? 0)
        scroller.scrollTop += (first > n + 1 ? -1 : 1) * scroller.clientHeight
      }
      await frame()
    }
    throw new Error('line not reached')
  }, line)
}

// previewError is the distance from the top of the preview pane to the element with the marker, less the article inset.
async function previewError(page: Page, marker: string) {
  return page.getByTestId('preview').evaluate((article, text) => {
    const pane = article.closest('section')!
    const el = Array.from(article.querySelectorAll<HTMLElement>('td, p')).find((e) => e.textContent?.trim() === text || e.textContent?.trim() === `Paragraph ${text} end.`)
    if (!el) return Infinity
    const inset = article.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop
    return Math.round(el.getBoundingClientRect().top - pane.getBoundingClientRect().top - inset)
  }, marker)
}

test('the preview follows the editor in a document of paragraphs', async ({ page }) => {
  const text = Array.from({ length: 120 }, (_, i) => `Paragraph P${i + 1} end.`).join('\n\n')
  await open(page, text)
  await scrollEditorTo(page, 2 * 59)
  await expect.poll(() => previewError(page, 'P60').then(Math.abs)).toBeLessThan(24)
})

test('the preview follows the editor through a table and a diagram', async ({ page }) => {
  const { text, markers } = acceptanceDoc()
  await open(page, text)
  await expect(page.getByTestId('preview').locator('.mermaid-block svg.flowchart')).toBeVisible({ timeout: 15_000 })
  const errors: Record<string, number> = {}
  for (const m of ['R10', 'R40', 'P1', 'P10', 'P20']) {
    await scrollEditorTo(page, markers.get(m)!)
    await page.waitForTimeout(100)
    errors[m] = await previewError(page, m)
  }
  console.log('scroll sync error in px', JSON.stringify(errors))
  for (const e of Object.values(errors)) expect(Math.abs(e)).toBeLessThan(24)
})
