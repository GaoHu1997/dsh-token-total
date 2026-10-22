/** The host ContextMeter is hard-coded beside composer.dock, not a slot.
 * Suppress only that recognizable sibling while our replacement is mounted;
 * never hide a whole dock, slot wrapper, or another plugin's readout. */
export function installContextTakeover(anchor: HTMLElement): () => void {
  const dock = anchor.closest<HTMLElement>('[data-composer-dock]')
  const view = anchor.ownerDocument.defaultView
  if (dock === null || view === null) return () => {}
  const hidden = new Map<HTMLElement, { display: string; priority: string }>()
  const reconcile = (): void => {
    for (const sibling of Array.from(dock.children)) {
      if (!(sibling instanceof view.HTMLElement) || sibling.tagName !== 'SPAN'
        || sibling.contains(anchor) || sibling.hasAttribute('data-slot-entry')
        || sibling.hasAttribute('data-dsh-token-total-stat')
        || hidden.has(sibling)) continue
      // ContextMeter's stable SVG geometry, not a private CSS-module hash or
      // a translated label. Current hosts mount its span directly in the dock.
      if (sibling.querySelector('button[aria-haspopup="dialog"] svg[viewBox="0 0 14 14"] circle[cx="7"][cy="7"][r="5.5"]') === null) continue
      hidden.set(sibling, { display: sibling.style.getPropertyValue('display'), priority: sibling.style.getPropertyPriority('display') })
      sibling.setAttribute('data-dsh-token-total-native-context', '')
      sibling.style.setProperty('display', 'none', 'important')
    }
  }
  reconcile()
  const observer = new view.MutationObserver(reconcile)
  observer.observe(dock, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    for (const [element, previous] of hidden) {
      element.removeAttribute('data-dsh-token-total-native-context')
      if (previous.display === '') element.style.removeProperty('display')
      else element.style.setProperty('display', previous.display, previous.priority)
    }
    hidden.clear()
  }
}
