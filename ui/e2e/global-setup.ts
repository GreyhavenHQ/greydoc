import { baseline } from './prefs'

// Most specs read the preview pane, so the local user of the test server starts in split view.
export default async function globalSetup() {
  const resp = await fetch('http://127.0.0.1:3999/api/me/prefs', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseline),
  })
  if (!resp.ok) throw new Error('set baseline prefs: ' + resp.status)
}
