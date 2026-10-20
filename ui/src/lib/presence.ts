// Local presence identity: in local mode a self-chosen name.

const NAME_KEY = 'greydoc-name'

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
