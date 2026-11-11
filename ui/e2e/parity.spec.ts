import { expect, test, type Page } from '@playwright/test'
import { startWith } from './prefs'
import { sample } from './sample'

const needles = [
  'Quarterly review',
  'Results',
  'Next steps',
  'This document collects the',
  'Confirm the budget',
  'one in Lyon',
  'Draft the plan',
  'Keep the summary',
  'Figures are unaudited',
  'select',
  'Europe',
  'Friday',
]

type Probe = Record<string, { left: number; width: number; style: Record<string, string> } | null>

async function probe(page: Page, root: string): Promise<Probe> {
  return page.evaluate(
    ([sel, list]) => {
      const out: Probe = {}
      const host = document.querySelector(sel as string)!
      for (const needle of list as string[]) {
        out[needle] = null
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
          const i = n.data.indexOf(needle)
          if (i < 0) continue
          const r = document.createRange()
          r.setStart(n, i)
          r.setEnd(n, i + needle.length)
          const rect = r.getBoundingClientRect()
          const cs = getComputedStyle(n.parentElement!)
          out[needle] = {
            left: rect.left,
            width: rect.width,
            style: {
              fontSize: cs.fontSize,
              fontWeight: cs.fontWeight,
              lineHeight: cs.lineHeight,
              letterSpacing: cs.letterSpacing,
              fontStyle: cs.fontStyle,
              color: cs.color,
            },
          }
          break
        }
      }
      return out
    },
    [root, needles] as const,
  )
}

startWith({ default_mode: 'live' })

// open uses HedgeDoc's ?view and ?edit. Without one, the note opens in live mode, the default of these tests.
async function open(page: Page, mode: '' | 'view' | 'edit', alias: string) {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto('/n/' + alias + (mode ? '?' + mode : ''))
}

test('live mode uses the styles of the view', async ({ browser }) => {
  const ctx = await browser.newContext()
  const resp = await ctx.request.post('http://127.0.0.1:3999/api/notes', { data: { content: sample } })
  const alias = (await resp.json()).alias

  const view = await ctx.newPage()
  await open(view, 'view', alias)
  await expect(view.getByTestId('preview').locator('h1')).toHaveText('Quarterly review')
  await expect(view.getByTestId('preview').locator('.hljs-keyword').first()).toBeVisible()
  const want = await probe(view, '[data-testid="preview"]')

  const live = await ctx.newPage()
  await open(live, '', alias)
  const editor = live.getByTestId('editor')
  await editor.locator('.cm-line', { hasText: 'Last edit' }).click()
  await live.keyboard.press('Control+End')
  await expect(editor.locator('.cm-lp-h1')).toHaveText('Quarterly review')
  await live.waitForTimeout(500)
  const got = await probe(live, '[data-testid="editor"]')

  for (const n of needles) {
    expect(got[n], n).not.toBeNull()
    expect.soft(got[n]!.style, n).toEqual(want[n]!.style)
    expect.soft(Math.abs(got[n]!.left - want[n]!.left), `${n} left ${got[n]!.left} vs ${want[n]!.left}`).toBeLessThanOrEqual(1)
  }
  const title = 'Quarterly review'
  expect.soft(Math.abs(got[title]!.width - want[title]!.width), `title width ${got[title]!.width} vs ${want[title]!.width}`).toBeLessThanOrEqual(1)

  const h2 = editor.locator('.cm-lp-h2')
  expect(await h2.evaluate((el) => getComputedStyle(el).borderBottomStyle)).toBe('solid')
  await expect(editor.locator('.cm-lp-alert-title .cm-lp-kind-name')).toHaveText('Note')
  await expect(editor).not.toContainText('[!NOTE]')
  await expect(editor).not.toContainText('```')
  await ctx.close()
})

test('the source view keeps its heading style', async ({ page, request }) => {
  const resp = await request.post('/api/notes', { data: { content: sample } })
  await open(page, 'edit', (await resp.json()).alias)
  const line = page.getByTestId('editor').locator('.cm-line', { hasText: '# Quarterly review' })
  const body = page.getByTestId('editor').locator('.cm-line', { hasText: 'This document collects' })
  const size = (l: typeof line) => l.locator('span').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  const weight = await line.locator('span').first().evaluate((el) => getComputedStyle(el).fontWeight)
  expect(await size(line)).toBeGreaterThan(await body.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)))
  expect(Number(weight)).toBeGreaterThanOrEqual(700)
})
