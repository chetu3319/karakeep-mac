import type { WebContents } from 'electron'

/**
 * Pins a webContents' *page* zoom (zoomLevel/zoomFactor) at 0.
 *
 * The app is a fixed-layout UI with side panels sized in px, so Chromium
 * page zoom (⌘+ / ⌘- / ⌘0, ctrl+wheel) misaligns everything. Chromium also
 * persists zoom per origin, so a user who zoomed once stays zoomed on every
 * launch; we reset on creation and after loads to undo that.
 *
 * This is deliberately NOT visual zoom: we never touch
 * setVisualZoomLevelLimits and we let ctrl+wheel events reach the page, so
 * trackpad pinch inside the PDF reader / web view keeps working.
 */
export function lockPageZoom(wc: WebContents): void {
  const reset = (): void => {
    if (!wc.isDestroyed() && wc.getZoomLevel() !== 0) wc.setZoomLevel(0)
  }
  reset()

  // Belt and braces for the key shortcuts: with the View menu roles gone
  // Chromium has no accelerator for these, but swallow them anyway so they
  // can't zoom whichever webContents has focus. Other ⌘ combos pass through.
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control) || input.alt) return
    if (['=', '+', '-', '_', '0'].includes(input.key)) event.preventDefault()
  })

  // Fires when Chromium applies a zoom change (e.g. ctrl+wheel); undo it.
  wc.on('zoom-changed', reset)
  // Per-origin persisted zoom is applied as a page loads.
  wc.on('did-navigate', reset)
  wc.on('did-finish-load', reset)
}
