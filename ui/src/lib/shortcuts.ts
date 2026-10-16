export type Mode = 'live' | 'edit' | 'both' | 'view'

const modeKeys: Record<string, Mode> = { KeyL: 'live', KeyE: 'edit', KeyB: 'both', KeyV: 'view' }

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

// modeFromKey returns the mode for Ctrl+Alt+L/E/B/V, or null when the key press belongs to something else.
export function modeFromKey(e: KeyboardEvent, mac = isMac): Mode | null {
  if (e.defaultPrevented || e.isComposing || !(e.ctrlKey || e.metaKey) || !e.altKey) return null
  const mode = modeKeys[e.code]
  if (!mode) return null
  // On Windows and Linux, AltGr reports Ctrl+Alt. A typed character such as € means it is not a shortcut.
  if (!mac && (e.getModifierState('AltGraph') || e.key.toLowerCase() !== e.code.slice(3).toLowerCase())) return null
  const t = e.target
  if (t instanceof Element) {
    if (t.closest('[role=dialog],[role=alertdialog],[role=menu]')) return null
    if (t.closest('input, textarea, select, [contenteditable]') && !t.closest('.cm-editor')) return null
  }
  if (document.querySelector('[role=dialog][data-state=open],[role=alertdialog][data-state=open]')) return null
  return mode
}
