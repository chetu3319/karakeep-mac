/**
 * Manages a single WebContentsView layered over the main BrowserWindow's
 * renderer, positioned by bounds reported from the renderer (the "Web" tab
 * of the detail pane). This is the highest-risk piece of Milestone 1 —
 * see BRIEF.md.
 */
import { BrowserWindow, WebContentsView, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { IPC, WEBPANE_IPC } from '../shared/ipc'
import type { WebPaneBounds, WebPaneState } from '../shared/types'

const WEBPANE_PRELOAD = join(__dirname, '../preload/webpane.mjs')

export class WebPaneManager {
  private view: WebContentsView | null = null
  private attached = false
  private win: BrowserWindow
  private currentBookmarkId: string | null = null
  private pendingHighlights: unknown[] = []
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
    wc.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

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
    wc.on('page-title-updated', () => pushState())
    wc.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      if (errorCode === -3) return // ERR_ABORTED, usually a redirect/cancel — not a real failure
      pushState({ error: `${errorDescription} (${errorCode})`, isLoading: false })
    })
    wc.on('dom-ready', () => {
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
