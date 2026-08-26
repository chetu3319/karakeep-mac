/**
 * Who gets to decide whether the live page is on screen.
 *
 * The live page is a native WebContentsView layered *over* the renderer, so
 * it is painted above every piece of app UI regardless of z-index. That is
 * what we want while reading, and exactly what we don't want the moment a
 * dialog opens: Settings and Add bookmark were being drawn underneath it.
 *
 * Two independent inputs decide visibility, and neither can be expressed by
 * the other:
 *
 * - **want**: the Web tab is the active tab (owned by WebPane).
 * - **suppressions**: something modal is on screen and must not be covered.
 *   A count, not a flag — a confirm dialog can open on top of Settings, and
 *   the first one to close must not un-hide the pane out from under the
 *   second.
 *
 * Everything funnels through here so the two never race: whichever fires
 * last, the effective state is recomputed from both.
 */

let want = false
let suppressions = 0
let applied = false
const onShown = new Set<() => void>()

function sync(): void {
  const next = want && suppressions === 0
  if (next === applied) return
  applied = next
  if (next) {
    void window.kk.webpane.show()
    // The view keeps the bounds it was last given, but the layout it was
    // hidden for may have changed underneath it (the rail opening, the
    // window resizing while a dialog was up). Re-measure on the way back.
    onShown.forEach((cb) => cb())
  } else {
    void window.kk.webpane.hide()
  }
}

/** Called by WebPane as its tab becomes active/inactive. */
export function setWebPaneWanted(next: boolean): void {
  want = next
  sync()
}

/**
 * Hides the live page for as long as the returned release function hasn't
 * been called. Safe to call from a mount effect and release on unmount;
 * releasing twice is a no-op.
 */
export function suppressWebPane(): () => void {
  suppressions += 1
  sync()
  let released = false
  return () => {
    if (released) return
    released = true
    suppressions -= 1
    sync()
  }
}

/** Runs `cb` each time the pane comes back on screen. Returns an unsubscribe. */
export function onWebPaneShown(cb: () => void): () => void {
  onShown.add(cb)
  return () => {
    onShown.delete(cb)
  }
}
