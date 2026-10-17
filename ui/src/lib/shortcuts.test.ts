import { afterEach, describe, expect, it } from 'vitest'
import { modeFromKey, type Mode } from '@/lib/shortcuts'

afterEach(() => {
  document.body.innerHTML = ''
})

function press(target: Element, init: KeyboardEventInit, mac = false): Mode | null {
  let got: Mode | null = null
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.addEventListener('keydown', (e) => (got = modeFromKey(e, mac)), { once: true })
  target.dispatchEvent(ev)
  return got
}

const ctrlAltE = { ctrlKey: true, altKey: true, code: 'KeyE', key: 'e' }

describe('modeFromKey', () => {
  it('switches mode from the page and from the editor', () => {
    expect(press(document.body, ctrlAltE)).toBe('edit')
    document.body.innerHTML = '<div class="cm-editor"><div class="cm-content" contenteditable="true"></div></div>'
    expect(press(document.querySelector('.cm-content')!, { ...ctrlAltE, code: 'KeyV', key: 'v' })).toBe('view')
  })
  it('ignores keys while a dialog is open', () => {
    document.body.innerHTML = '<div role="dialog" data-state="open"><button>x</button></div>'
    expect(press(document.querySelector('button')!, ctrlAltE)).toBeNull()
  })
  it('ignores keys typed in another text field', () => {
    document.body.innerHTML = '<textarea></textarea><input>'
    expect(press(document.querySelector('textarea')!, ctrlAltE)).toBeNull()
    expect(press(document.querySelector('input')!, ctrlAltE)).toBeNull()
  })
  it('ignores AltGr characters on Windows and Linux', () => {
    expect(press(document.body, { ...ctrlAltE, key: '€' })).toBeNull()
    expect(press(document.body, { ...ctrlAltE, modifierAltGraph: true } as KeyboardEventInit)).toBeNull()
  })
  it('accepts the Option character on a Mac', () => {
    expect(press(document.body, { ...ctrlAltE, key: '´' }, true)).toBe('edit')
  })
  it('ignores a key already handled', () => {
    document.body.addEventListener('keydown', (e) => e.preventDefault(), { once: true })
    expect(press(document.body, ctrlAltE)).toBeNull()
  })
})
