const marker = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/

// taskToggle returns the edit that flips the task box on a zero-based line, or null if the line has none.
export function taskToggle(text: string, line: number): { offset: number; insert: string } | null {
  let start = 0
  for (let i = 0; i < line; i++) {
    const next = text.indexOf('\n', start)
    if (next < 0) return null
    start = next + 1
  }
  const end = text.indexOf('\n', start)
  const m = marker.exec(text.slice(start, end < 0 ? undefined : end))
  if (!m) return null
  return { offset: start + m[1].length, insert: m[2] === ' ' ? 'x' : ' ' }
}
