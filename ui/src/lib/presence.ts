// Local presence identity: a stable color, and in local mode a self-chosen name.

const NAME_KEY = 'greydoc-name'
const COLOR_KEY = 'greydoc-color'

const palette = ['#d95e2a', '#2a7fd9', '#2aa876', '#a62ad9', '#d92a6b', '#c49a00', '#00a3a3', '#6b6bd9']

export function presenceColor(): string {
  let c = localStorage.getItem(COLOR_KEY)
  if (!c) {
    c = palette[Math.floor(Math.random() * palette.length)]
    localStorage.setItem(COLOR_KEY, c)
  }
  return c
}

const animals = ['Otter', 'Heron', 'Lynx', 'Badger', 'Falcon', 'Marten', 'Ibex', 'Puffin', 'Stoat', 'Wren']

export function localName(): string {
  let n = localStorage.getItem(NAME_KEY)
  if (!n) {
    n = 'Anonymous ' + animals[Math.floor(Math.random() * animals.length)]
    localStorage.setItem(NAME_KEY, n)
  }
  return n
}

export function setLocalName(name: string) {
  localStorage.setItem(NAME_KEY, name)
}
