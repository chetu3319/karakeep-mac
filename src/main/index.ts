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
  ipcMain.handle(IPC.WEBPANE_SET_BOUNDS, (_e, bounds: WebPaneBounds) => webPane?.setBounds(bounds))
  ipcMain.handle(IPC.WEBPANE_SHOW, () => webPane?.show())
  ipcMain.handle(IPC.WEBPANE_HIDE, () => webPane?.hide())
  ipcMain.handle(IPC.WEBPANE_DESTROY, () => webPane?.destroy())
  ipcMain.handle(IPC.WEBPANE_BACK, () => webPane?.back())
  ipcMain.handle(IPC.WEBPANE_FORWARD, () => webPane?.forward())
  ipcMain.handle(IPC.WEBPANE_RELOAD, () => webPane?.reload())
  ipcMain.handle(IPC.WEBPANE_STOP, () => webPane?.stop())
  ipcMain.handle(IPC.WEBPANE_OPEN_EXTERNAL, (_e, url: string) => shell.openExternal(url))
}

async function onHighlightEvent(
  type: 'created' | 'updated' | 'removed',
  payload: unknown,
  bookmarkId: string | null
): Promise<void> {
  if (!apiClient || !bookmarkId) return
  try {
    const p = payload as {
      id: string
      text?: string
      color?: string
      note?: string
      startOffset: number
      endOffset: number
    }
    if (type === 'created') {
      await apiClient.createHighlight({
        bookmarkId,
        startOffset: p.startOffset,
        endOffset: p.endOffset,
        color: p.color,
        text: p.text,
        note: p.note
      })
    } else if (type === 'updated') {
      // Client-side highlight ids from the preload aren't server ids yet in
      // this vertical slice's create-then-update-note flow within the same
      // session; best-effort — a full id-reconciliation pass is follow-up work.
      console.log('[highlights] update event (not yet reconciled to server id)', p.id)
    } else if (type === 'removed') {
      console.log('[highlights] remove event (not yet reconciled to server id)', p.id)
    }
    mainWindow?.webContents.send(IPC.WEBPANE_HIGHLIGHTS_CHANGED_EVENT, { bookmarkId })
  } catch (err) {
    console.error('[highlights] sync failed', err instanceof Error ? err.message : err)
  }
}

async function runSmokeMode(win: BrowserWindow, pane: WebPaneManager): Promise<void> {
  const dir = join(projectRoot, 'tmp-screenshots')
  mkdirSync(dir, { recursive: true })

  async function shot(name: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 600))
    const image = await win.webContents.capturePage()
    writeFileSync(join(dir, name), image.toPNG())
    console.log('[smoke] saved', name)
  }

  // Register these listeners immediately — the renderer may fire its
  // "ready" events before we get around to awaiting them below, and a
  // late `ipcMain.once` would miss an event that already fired.
  const detailReady = new Promise<void>((resolve) => ipcMain.once('dev:smoke-detail-ready', () => resolve()))
  const webReady = new Promise<void>((resolve) => ipcMain.once('dev:smoke-web-ready', () => resolve()))

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
  const paneOnly = await pane.capturePaneOnly()
  if (paneOnly) {
    writeFileSync(join(dir, '03b-web-pane-only.png'), paneOnly)
    console.log('[smoke] saved 03b-web-pane-only.png')
  }

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
