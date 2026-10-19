import { displayNames, isSelf, mentionsOn } from '@/lib/mentions'

// hydrateMentions shows the current name of each mentioned person. Signed-out viewers keep the name in the text.
export async function hydrateMentions(root: HTMLElement): Promise<void> {
  if (!mentionsOn()) return
  const chips = Array.from(root.querySelectorAll<HTMLElement>('.mention[data-user]'))
  if (!chips.length) return
  const names = await displayNames(chips.map((c) => c.dataset.user!))
  for (const c of chips) {
    c.classList.toggle('mention-self', isSelf(c.dataset.user!))
    const n = names.get(c.dataset.user!)
    if (n && c.isConnected) c.textContent = '@' + n
  }
}
