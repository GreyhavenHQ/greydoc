import { test } from '@playwright/test'

type Prefs = { default_mode?: 'live' | 'editor' | 'split' | 'preview'; live_style?: 'document' | 'obsidian' }

// startWith sets the preferences of the local user for each test of a file, and resets them after.
// The e2e server runs in local mode, so every page shares them.
export function startWith(prefs: Prefs) {
  test.beforeEach(async ({ request }) => {
    const resp = await request.patch('/api/me/prefs', { data: prefs })
    if (resp.status() !== 200) throw new Error('set prefs: ' + resp.status())
  })
  test.afterEach(async ({ request }) => {
    await request.patch('/api/me/prefs', { data: baseline })
  })
}

// baseline is what most specs expect: the split view of HedgeDoc. global-setup.ts sets it before the first test.
export const baseline = { default_mode: 'split', live_style: 'obsidian' } as const
