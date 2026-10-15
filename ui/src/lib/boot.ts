// The server inlines data the first page needs, to save round trips. Each entry is used once, on first render.
type Boot = { me?: unknown; note?: { alias: string; data: unknown }; share?: { token: string; alias: string } }

let boot: Boot | null = null
try {
  const el = document.getElementById('greydoc-boot')
  boot = el?.textContent ? (JSON.parse(el.textContent) as Boot) : null
} catch {
  boot = null
}

export function takeBoot<K extends keyof Boot>(key: K): Boot[K] | undefined {
  const v = boot?.[key]
  if (boot) delete boot[key]
  return v
}
