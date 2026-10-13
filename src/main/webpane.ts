/**
 * Manages a single WebContentsView layered over the main BrowserWindow's
 * renderer, positioned by bounds reported from the renderer (the "Web" tab
 * of the detail pane). This is the highest-risk piece of Milestone 1 —
 * see BRIEF.md.
 */
import { BrowserWindow, WebContentsView, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { IPC, WEBPANE_IPC } from '../shared/ipc'
import type { WebPaneBounds, WebPaneFindResult, WebPaneState } from '../shared/types'
import { lockPageZoom } from './zoomLock'

/** Longest a quote reveal waits for the page to exist, load and answer. */
const REVEAL_BUDGET_MS = 10_000
const WEBPANE_PRELOAD = join(__dirname, '../preload/webpane.mjs')

export class WebPaneManager {
  private view: WebContentsView | null = null
  private attached = false
  private win: BrowserWindow
  private currentBookmarkId: string | null = null
  private pendingHighlights: unknown[] = []
  private pendingReveals = new Map<string, (result: 'found' | 'not-found' | 'unavailable') => void>()
  private onHighlightEvent: (type: 'created' | 'updated' | 'removed', payload: unknown, bookmarkId: string | null) => void

  constructor(
    win: BrowserWindow,
    onHighlightEvent: (type: 'created' | 'updated' | 'removed', payload: unknown, bookmarkId: string | null) => void
  ) {
    this.win = win
    this.onHighlightEvent = onHighlightEvent
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view

    const view = new WebContentsView({
      webPreferences: {
        preload: WEBPANE_PRELOAD,
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false
      }
    })
    this.view = view

    const wc = view.webContents
    lockPageZoom(wc)
    wc.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    // Trackpad pinch magnifies the page like Safari does, without reflowing
    // it, and pinching back out returns to 100%. This is visual zoom only: it
    // is separate from the page zoom level, and is off by default (1..1).
    // Applied again on `dom-ready` below in case a navigation resets it.
    const enablePinchZoom = (): void => void wc.setVisualZoomLevelLimits(1, 3)
    enablePinchZoom()

    const pushState = (extra?: Partial<WebPaneState>): void => {
      if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return
      const state: WebPaneState = {
        url: wc.getURL(),
        title: wc.getTitle(),
        isLoading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        error: null,
        ...extra
      }
      this.win.webContents.send(IPC.WEBPANE_STATE_EVENT, state)
    }

    wc.on('did-start-loading', () => pushState())
    wc.on('did-stop-loading', () => pushState())
    wc.on('did-navigate', () => pushState())
    wc.on('did-navigate-in-page', () => {
      pushState()
      // Same-document (SPA) navigation swaps the page's content without
      // re-running the preload, so re-push what we owe this bookmark.
      if (this.pendingHighlights.length) wc.send(WEBPANE_IPC.APPLY, this.pendingHighlights)
    })
    wc.on('found-in-page', (_e, result) => {
      if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return
      const found: WebPaneFindResult = {
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
        finalUpdate: result.finalUpdate
      }
      this.win.webContents.send(IPC.WEBPANE_FOUND_EVENT, found)
    })
    // A real navigation replaces the document the highlights belonged to.
    // The renderer re-runs the query against the new page if the bar is
    // still open; this just makes sure nothing stale stays painted.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        this.stopFind()
        this.abandonReveals()
      }
    })
    wc.on('page-title-updated', () => pushState())
    wc.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      if (errorCode === -3) return // ERR_ABORTED, usually a redirect/cancel — not a real failure
      pushState({ error: `${errorDescription} (${errorCode})`, isLoading: false })
    })
    wc.on('dom-ready', () => {
      enablePinchZoom()
      // Give the page a moment to settle, then push down any highlights
      // we owe it for the bookmark currently loaded in this view.
      if (this.pendingHighlights.length) {
        wc.send(WEBPANE_IPC.APPLY, this.pendingHighlights)
      }
    })

    const fromThisView = (senderId: number): boolean => senderId === wc.id

    ipcMain.on(WEBPANE_IPC.HIGHLIGHT_CREATED, (e, payload) => {
      if (!fromThisView(e.sender.id)) return
      this.onHighlightEvent('created', payload, this.currentBookmarkId)
    })
    ipcMain.on(WEBPANE_IPC.HIGHLIGHT_UPDATED, (e, payload) => {
      if (!fromThisView(e.sender.id)) return
      this.onHighlightEvent('updated', payload, this.currentBookmarkId)
    })
    ipcMain.on(WEBPANE_IPC.HIGHLIGHT_REMOVED, (e, payload) => {
      if (!fromThisView(e.sender.id)) return
      this.onHighlightEvent('removed', payload, this.currentBookmarkId)
    })
    ipcMain.on(WEBPANE_IPC.READY, (e) => {
      if (!fromThisView(e.sender.id)) return
      if (this.pendingHighlights.length) wc.send(WEBPANE_IPC.APPLY, this.pendingHighlights)
    })
    ipcMain.on(WEBPANE_IPC.REVEAL_RESULT, (e, payload: { requestId: string; found: boolean }) => {
      if (!fromThisView(e.sender.id)) return
      const done = this.pendingReveals.get(payload?.requestId)
      if (done) done(payload.found === true ? 'found' : 'not-found')
    })
    ipcMain.on(WEBPANE_IPC.STATUS, (e, payload: { anchored: string[]; missing: string[] }) => {
      if (!fromThisView(e.sender.id)) return
      if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return
      this.win.webContents.send(IPC.WEBPANE_HIGHLIGHT_STATUS_EVENT, {
        bookmarkId: this.currentBookmarkId,
        ...payload
      })
    })

    return view
  }

  navigate(url: string, bookmarkId: string, highlights: unknown[]): void {
    if (this.win.isDestroyed()) return
    const view = this.ensureView()
    this.currentBookmarkId = bookmarkId
    this.pendingHighlights = highlights
    this.stopFind()
    view.webContents.loadURL(url).catch((err) => {
      console.error('[webpane] loadURL failed', err instanceof Error ? err.message : err)
    })
  }

  /**
   * Pushes the current highlight set into the live page without navigating.
   * The renderer's highlight query resolves *after* the first navigate on a
   * cold start, so without this the pane would be told to apply an empty
   * list and never hear about the real one.
   */
  applyHighlights(highlights: unknown[]): void {
    this.pendingHighlights = highlights
    if (!this.view || this.view.webContents.isDestroyed()) return
    this.view.webContents.send(WEBPANE_IPC.APPLY, highlights)
  }

  /**
   * Tells the live page the server id for a highlight it created locally.
   * Without this the page keeps its client-generated `kh-...` id, and the
   * next full sync (which arrives from the server carrying the real id)
   * would anchor the very same text a second time.
   */
  assignHighlightId(clientId: string, serverId: string): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    this.view.webContents.send(WEBPANE_IPC.ID_ASSIGNED, { clientId, serverId })
  }

  /** Scrolls one highlight into view in the live page and flashes it. */
  focusHighlight(highlightId: string): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    this.view.webContents.send(WEBPANE_IPC.FOCUS, highlightId)
  }

  /**
   * Asks the live page to scroll to a quote and flash it. The page does the
   * matching. 'unavailable' means nothing was learned (no view, a different
   * bookmark is showing, the page never finished loading within the bound, it
   * navigated away, or it did not answer), so callers must not treat it as
   * "not on the page". The whole wait, view creation and load included, is
   * bounded by REVEAL_BUDGET_MS.
   */
  async revealQuote(quote: string, bookmarkId?: string): Promise<'found' | 'not-found' | 'unavailable'> {
    const deadline = Date.now() + REVEAL_BUDGET_MS
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const live = (): Electron.WebContents | null =>
      this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null
    // The view appears when the Web tab first navigates, which can trail the click.
    while (!live() && Date.now() < deadline) await sleep(50)
    let wc = live()
    if (!wc) return 'unavailable'
    while (wc.isLoading() && Date.now() < deadline) {
      await sleep(50)
      wc = live()
      if (!wc) return 'unavailable'
    }
    if (wc.isLoading()) return 'unavailable'
    if (bookmarkId && this.currentBookmarkId !== bookmarkId) return 'unavailable'
    const requestId = `rq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve) => {
      const finish = (r: 'found' | 'not-found' | 'unavailable'): void => {
        clearTimeout(timer)
        this.pendingReveals.delete(requestId)
        resolve(r)
      }
      const timer = setTimeout(() => finish('unavailable'), Math.max(500, Math.min(3000, deadline - Date.now())))
      this.pendingReveals.set(requestId, finish)
      wc!.send(WEBPANE_IPC.REVEAL_QUOTE, { requestId, quote })
    })
  }

  /** The page the requests were for is going away; nobody should wait out their timers. */
  private abandonReveals(): void {
    for (const finish of Array.from(this.pendingReveals.values())) finish('unavailable')
  }

  /**
   * Reads the live page's rendered text straight out of the WebContentsView
   * via `executeJavaScript`, rather than through the highlight preload's own
   * IPC channel — the sidebar chat wants this on demand from the renderer,
   * not pushed proactively, and `document.body.innerText` is cheap enough to
   * fetch synchronously-from-the-caller's-perspective each time it's asked.
   * Returns '' for anything that can't answer (no view, destroyed, JS threw)
   * so a slow/broken page degrades the chat's grounding rather than crashing it.
   */
  async getPageText(): Promise<string> {
    if (!this.view || this.view.webContents.isDestroyed()) return ''
    try {
      const text = await this.view.webContents.executeJavaScript('document.body ? document.body.innerText : ""')
      return typeof text === 'string' ? text : ''
    } catch {
      return ''
    }
  }

  /**
   * Find-in-page. Electron's `findNext` flag is named backwards from what a
   * caller expects: `true` begins a *new* session (the query changed),
   * `false` continues the running one to its next/previous match. Callers
   * here say `newSession` and this maps it.
   */
  find(text: string, forward: boolean, newSession: boolean): void {
    if (!this.view || this.view.webContents.isDestroyed() || !text) return
    this.view.webContents.findInPage(text, { forward, findNext: newSession, matchCase: false })
  }

  stopFind(): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    this.view.webContents.stopFindInPage('clearSelection')
  }

  setBounds(bounds: WebPaneBounds): void {
    if (!this.view) return
    if (this.win.isDestroyed() || this.view.webContents.isDestroyed()) return
    this.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    })
  }

  isAttached(): boolean {
    return this.attached
  }

  show(): void {
    if (this.win.isDestroyed()) return
    const view = this.ensureView()
    if (!this.attached) {
      this.win.contentView.addChildView(view)
      this.attached = true
    }
  }

  hide(): void {
    // Guard against every path that can reach this after teardown has
    // started: a 'close'-time destroy() call, or a stray WEBPANE_HIDE /
    // WEBPANE_DESTROY IPC message arriving from a renderer that hasn't
    // unmounted yet while the window is on its way out.
    if (!this.view || !this.attached) return
    if (this.win.isDestroyed()) {
      this.attached = false
      return
    }
    this.win.contentView.removeChildView(this.view)
    this.attached = false
  }

  destroy(): void {
    this.abandonReveals()
    if (this.view) {
      this.hide()
      this.attached = false
      // WebContentsView has no explicit destroy API; dropping all refs and
      // closing the WebContents lets it be GC'd. Guard against the
      // WebContents already being gone (e.g. window closed out from under
      // us) — close() on a destroyed WebContents throws.
      if (!this.view.webContents.isDestroyed()) {
        this.view.webContents.close()
      }
      this.view = null
    }
    this.currentBookmarkId = null
    this.pendingHighlights = []
  }

  back(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.navigationHistory.goBack()
  }
  forward(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.navigationHistory.goForward()
  }
  reload(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.reload()
  }
  stop(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.stop()
  }
  getCurrentUrl(): string {
    if (!this.view || this.view.webContents.isDestroyed()) return ''
    return this.view.webContents.getURL()
  }

  /** Dev/debug only: capture the live page's own compositor output directly. */
  async capturePaneOnly(): Promise<Buffer | null> {
    if (!this.view || this.view.webContents.isDestroyed()) return null
    const image = await this.view.webContents.capturePage()
    return image.toPNG()
  }
}
