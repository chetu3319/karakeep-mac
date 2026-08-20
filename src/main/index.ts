import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { KarakeepApiClient } from './api'
import * as store from './store'
import { loadDotEnvLocal } from './env'
import { buildAppMenu } from './menu'
import { WebPaneManager } from './webpane'
import { IPC } from '../shared/ipc'
import type { AuthResult, WebPaneBounds } from '../shared/types'

const isDev = !app.isPackaged
const projectRoot = join(__dirname, '../..')

let apiClient: KarakeepApiClient | null = null
let mainWindow: BrowserWindow | null = null
let webPane: WebPaneManager | null = null

function makeClientFromStore(): KarakeepApiClient | null {
  const resolved = store.getResolvedConfig()
  if (!resolved) return null
  return new KarakeepApiClient(resolved)
}

function requireClient(): KarakeepApiClient {
  if (!apiClient) throw new Error('Not signed in')
  return apiClient
}

function requirePane(): WebPaneManager {
  if (!webPane) throw new Error('No window')
  return webPane
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerIpc(): void {
  ipcMain.handle(IPC.CONFIG_GET, () => store.getConfig())

  ipcMain.handle(IPC.CONFIG_SET, async (_e, input: { baseUrl: string; apiKey: string; customHeaders?: Record<string, string> }) => {
    store.setConfig(input)
    apiClient = makeClientFromStore()
    return store.getConfig()
  })

  ipcMain.handle(IPC.CONFIG_SIGN_OUT, () => {
    store.clearConfig()
    apiClient = null
  })

  ipcMain.handle(IPC.AUTH_TEST, async (): Promise<AuthResult> => {
    try {
      const client = apiClient ?? makeClientFromStore()
      if (!client) return { ok: false, error: 'Not configured' }
      const user = await client.getMe()
      apiClient = client
      return { ok: true, user }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(IPC.API_LIST_BOOKMARKS, (_e, params: { limit?: number; cursor?: string }) =>
    requireClient().listBookmarks(params)
  )
  ipcMain.handle(IPC.API_SEARCH_BOOKMARKS, (_e, params: { q: string; limit?: number; cursor?: string }) =>
    requireClient().searchBookmarks(params)
  )
  ipcMain.handle(IPC.API_GET_LISTS, () => requireClient().getLists())
  ipcMain.handle(IPC.API_GET_TAGS, () => requireClient().getTags())
  ipcMain.handle(IPC.API_GET_HIGHLIGHTS, (_e, params: { cursor?: string; limit?: number }) =>
    requireClient().getHighlights(params)
  )
  ipcMain.handle(IPC.API_GET_BOOKMARK_HIGHLIGHTS, (_e, bookmarkId: string) =>
    requireClient().getBookmarkHighlights(bookmarkId)
  )
  ipcMain.handle(IPC.API_GET_LIST_BOOKMARKS, (_e, args: { listId: string; limit?: number; cursor?: string }) =>
    requireClient().getListBookmarks(args.listId, { limit: args.limit, cursor: args.cursor })
  )
  ipcMain.handle(IPC.API_GET_TAG_BOOKMARKS, (_e, args: { tagId: string; limit?: number; cursor?: string }) =>
    requireClient().getTagBookmarks(args.tagId, { limit: args.limit, cursor: args.cursor })
  )
  ipcMain.handle(IPC.API_GET_ASSET, (_e, assetId: string) => requireClient().getAssetDataUrl(assetId))

  ipcMain.on(IPC.WINDOW_MINIMIZE, () => mainWindow?.minimize())
  ipcMain.on(IPC.WINDOW_MAXIMIZE, () => {
    if (!mainWindow) return
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  })
  ipcMain.on(IPC.WINDOW_CLOSE, () => mainWindow?.close())

  ipcMain.handle(IPC.WEBPANE_NAVIGATE, (_e, args: { url: string; bookmarkId: string; highlights: unknown[] }) => {
    requirePane().navigate(args.url, args.bookmarkId, args.highlights)
  })
  ipcMain.handle(IPC.WEBPANE_APPLY_HIGHLIGHTS, (_e, args: { highlights: unknown[] }) => {
    webPane?.applyHighlights(args.highlights)
  })
  ipcMain.handle(IPC.WEBPANE_FOCUS_HIGHLIGHT, (_e, highlightId: string) => {
    webPane?.focusHighlight(highlightId)
  })
  ipcMain.handle(IPC.WEBPANE_SET_BOUNDS, (_e, bounds: WebPaneBounds) => webPane?.setBounds(bounds))
  ipcMain.handle(IPC.WEBPANE_SHOW, () => webPane?.show())
  ipcMain.handle(IPC.WEBPANE_HIDE, () => webPane?.hide())
  ipcMain.handle(IPC.WEBPANE_IS_ATTACHED, () => webPane?.isAttached() ?? false)
  ipcMain.handle(IPC.WEBPANE_DESTROY, () => webPane?.destroy())
  ipcMain.handle(IPC.WEBPANE_BACK, () => webPane?.back())
  ipcMain.handle(IPC.WEBPANE_FORWARD, () => webPane?.forward())
  ipcMain.handle(IPC.WEBPANE_RELOAD, () => webPane?.reload())
  ipcMain.handle(IPC.WEBPANE_STOP, () => webPane?.stop())
  ipcMain.handle(IPC.WEBPANE_OPEN_EXTERNAL, (_e, url: string) => shell.openExternal(url))
}

// Reconciles preload-local highlight ids to server-assigned ids within a
// session. A highlight created this session is known to the preload only by
// its client-generated `kh-...` id until POST /highlights resolves; a
// PATCH/DELETE for a note edited or deleted in the same beat (e.g. "select
// text, add a note immediately") must not silently no-op just because the
// server id hasn't come back yet — it must wait for the in-flight creation
// and then target the real id. Highlights that were loaded *from* the
// server (existing highlights applied to the page on load) already carry
// the server id as their preload-side `id`, so they need no reconciliation
// at all; the `serverIdByKey` map only ever gains entries for
// session-created highlights, so falling through to `p.id` is correct for
// the pre-existing case.
const serverIdByKey = new Map<string, string>()
const pendingCreations = new Map<string, Promise<{ id: string }>>()

function highlightKey(bookmarkId: string, clientId: string): string {
  return `${bookmarkId}:${clientId}`
}

async function onHighlightEvent(
  type: 'created' | 'updated' | 'removed',
  payload: unknown,
  bookmarkId: string | null
): Promise<void> {
  if (!apiClient || !bookmarkId) return
  const client = apiClient
  const p = payload as {
    id: string
    text?: string
    color?: string
    note?: string
    startOffset: number
    endOffset: number
  }
  const key = highlightKey(bookmarkId, p.id)

  try {
    if (type === 'created') {
      const promise = client.createHighlight({
        bookmarkId,
        startOffset: p.startOffset,
        endOffset: p.endOffset,
        color: p.color,
        text: p.text,
        note: p.note
      })
      pendingCreations.set(key, promise)
      try {
        const created = await promise
        serverIdByKey.set(key, created.id)
        webPane?.assignHighlightId(p.id, created.id)
      } finally {
        pendingCreations.delete(key)
      }
    } else if (type === 'updated' || type === 'removed') {
      let serverId = serverIdByKey.get(key)
      if (serverId === undefined) {
        const inFlight = pendingCreations.get(key)
        if (inFlight) {
          // A PATCH/DELETE raced ahead of its own creation — wait for the
          // server id rather than dropping the edit/delete on the floor.
          const created = await inFlight
          serverId = created.id
        }
      }
      // Falls through to the client id itself for highlights that were
      // never created this session (loaded from the server already
      // carrying their real id) — see the function-level comment.
      if (serverId === undefined) serverId = p.id

      if (type === 'updated') {
        await client.updateHighlight(serverId, { color: p.color, note: p.note })
      } else {
        await client.deleteHighlight(serverId)
        serverIdByKey.delete(key)
      }
    }
    mainWindow?.webContents.send(IPC.WEBPANE_HIGHLIGHTS_CHANGED_EVENT, { bookmarkId })
  } catch (err) {
    console.error(`[highlights] ${type} sync failed`, err instanceof Error ? err.message : err)
  }
}

async function runSmokeMode(win: BrowserWindow, pane: WebPaneManager): Promise<void> {
  const dir = join(projectRoot, 'tmp-screenshots')
  mkdirSync(dir, { recursive: true })

  async function shot(name: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 600))
    // macOS's screen-capture surface can transiently throw
    // "Current display surface not available for capture" — retry once
    // rather than losing a whole smoke run (and, for 04, the evidence the
    // stale-selection fix actually needs) to a flake.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Best-effort: force a fresh paint before capturing. Note this
        // session's capturePage() has been observed to occasionally return
        // a stale/cached compositor frame — see the report in this run's
        // summary. Do NOT shell out to an OS-level screen-capture tool as
        // a workaround: it captures the user's real physical display, not
        // this app's window, which is a privacy problem, not a fix.
        win.webContents.invalidate()
        await new Promise((r) => setTimeout(r, 400))
        const image = await win.webContents.capturePage()
        writeFileSync(join(dir, name), image.toPNG())
        console.log('[smoke] saved', name)
        return
      } catch (err) {
        console.error(`[smoke] capture attempt ${attempt} failed for ${name}`, err instanceof Error ? err.message : err)
        if (attempt === 2) throw err
        await new Promise((r) => setTimeout(r, 800))
      }
    }
  }

  // Register these listeners immediately — the renderer may fire its
  // "ready" events before we get around to awaiting them below, and a
  // late `ipcMain.once` would miss an event that already fired.
  const detailReady = new Promise<void>((resolve) => ipcMain.once('dev:smoke-detail-ready', () => resolve()))
  const webReady = new Promise<void>((resolve) => ipcMain.once('dev:smoke-web-ready', () => resolve()))
  const listReady = new Promise<void>((resolve) => ipcMain.once('dev:smoke-list-ready', () => resolve()))

  // Safety timeout in case the renderer-driven steps stall.
  const safety = setTimeout(() => {
    console.log('[smoke] timeout reached, quitting')
    app.quit()
  }, 25000)

  // Step 1: library view, nothing selected yet.
  await new Promise((r) => setTimeout(r, 1500))
  await shot('01-library.png')

  win.webContents.send('dev:smoke-start')

  // Step 2: a bookmark is selected, Preview tab showing.
  await detailReady
  await shot('02-detail.png')

  // Step 3: explicitly flip to the Web tab now (not on a renderer-owned
  // timer) so this screenshot always lands after the tab has switched.
  win.webContents.send('dev:smoke-switch-to-web')
  await webReady
  await shot('03-web.png')

  // Also capture the live WebContentsView's own compositor output
  // directly, since capturing the parent BrowserWindow's webContents does
  // not necessarily include an overlaid child WebContentsView's pixels.
  // Best-effort: macOS's screen-capture surface can transiently be
  // unavailable, and that must not abort the rest of this sequence (in
  // particular step 4 below, which is the one that matters for verifying
  // the pane actually detaches).
  try {
    const paneOnly = await pane.capturePaneOnly()
    if (paneOnly) {
      writeFileSync(join(dir, '03b-web-pane-only.png'), paneOnly)
      console.log('[smoke] saved 03b-web-pane-only.png')
    }
  } catch (err) {
    console.error('[smoke] pane-only capture failed (non-fatal)', err instanceof Error ? err.message : err)
  }

  // Step 4: select the first list in the sidebar and prove server-side
  // list-scoped filtering (GET /lists/{id}/bookmarks) actually narrows the
  // results shown, not just cosmetically highlighting the sidebar row.
  win.webContents.send('dev:smoke-select-list')
  await listReady

  // The list switch must have cleared the previously-selected bookmark,
  // which unmounts the Web tab and should have actually detached the
  // WebContentsView (contentView.removeChildView), not just hidden it
  // behind the (now list-only) detail pane. Verify the real attached
  // state directly on the manager rather than trusting a screenshot.
  await new Promise((r) => setTimeout(r, 300))
  if (pane.isAttached()) {
    console.error('[smoke] FAIL: web pane still attached after switching lists — stale-selection bug regressed')
  } else {
    console.log('[smoke] ok: web pane detached after switching lists')
  }

  await shot('04-list-filtered.png')

  clearTimeout(safety)
  if (process.env['KK_SMOKE_HOLD'] === '1') {
    console.log('[smoke] KK_SMOKE_HOLD=1 — leaving window open for manual close/quit testing')
    return
  }
  await new Promise((r) => setTimeout(r, 400))
  app.quit()
}

let ipcRegistered = false

/**
 * Creates the main window plus its WebPaneManager and wires up IPC and
 * lifecycle handlers. Called at startup and again from 'activate' if the
 * user quit all windows (Cmd+W) and then reopened from the Dock — macOS
 * keeps the app process alive in that case (see window-all-closed below),
 * so we need a fresh window + pane, not just the same createWindow() call
 * the original code made without re-wiring anything.
 */
function initWindow(): void {
  const win = createWindow()
  mainWindow = win
  const pane = new WebPaneManager(win, (type, payload, bookmarkId) => {
    void onHighlightEvent(type, payload, bookmarkId)
  })
  webPane = pane

  // ipcMain.handle/.on registrations are process-global, not per-window —
  // registering them again on a second window would throw
  // "second handler for X" and leak listeners bound to the stale window.
  // Route through the current pane/window via the module-level refs instead.
  if (!ipcRegistered) {
    registerIpc()
    ipcRegistered = true
  }

  // 'close' fires before the BrowserWindow (and its contentView) are torn
  // down, so the pane can still safely detach/close its child WebContents
  // here. By 'closed' the window and its native views are already gone —
  // touching them there throws "Object has been destroyed".
  win.on('close', () => {
    pane.destroy()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    if (webPane === pane) webPane = null
  })

  if (process.env['KK_SMOKE'] === '1') {
    win.webContents.once('did-finish-load', () => {
      void runSmokeMode(win, pane)
    })
  }

  // Temporary, dev-only lifecycle test hooks (not wired to any UI) — let a
  // driving script reproduce the exact window.close()/app.quit() paths
  // without needing OS-level UI automation permissions.
  if (process.env['KK_TEST_CLOSE_AFTER_MS']) {
    setTimeout(() => win.close(), Number(process.env['KK_TEST_CLOSE_AFTER_MS']))
  }
  if (process.env['KK_TEST_QUIT_AFTER_MS']) {
    setTimeout(() => app.quit(), Number(process.env['KK_TEST_QUIT_AFTER_MS']))
  }
}

app.whenReady().then(() => {
  const env = loadDotEnvLocal(projectRoot)
  store.seedFromEnvIfEmpty({
    KARAKEEP_BASE_URL: env['KARAKEEP_BASE_URL'],
    KARAKEEP_API_KEY: env['KARAKEEP_API_KEY']
  })
  apiClient = makeClientFromStore()

  Menu.setApplicationMenu(buildAppMenu())

  initWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) initWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
