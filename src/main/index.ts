import { app, BrowserWindow, ipcMain, screen, shell, Menu } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { KarakeepApiClient } from './api'
import { aiService } from './ai'
import * as store from './store'
import { loadDotEnvLocal } from './env'
import { buildAppMenu } from './menu'
import { WebPaneManager } from './webpane'
import { IPC } from '../shared/ipc'
import type {
  AiStreamRequest,
  AssetUploadInput,
  AuthResult,
  BookmarkListFilter,
  CreateBookmarkInput,
  CreateListInput,
  ListOrder,
  UpdateBookmarkInput,
  UpdateListInput,
  UpdateTagInput,
  WebPaneBounds
} from '../shared/types'

const isDev = !app.isPackaged
const projectRoot = join(__dirname, '../..')

/**
 * In a packaged build the icon comes from the app bundle, but `npm run
 * dev` runs inside the stock Electron binary and inherits its default
 * icon — so the Dock shows a generic Electron logo the whole time anyone
 * is working on the app. Point it at the same artwork the build ships.
 */
function setDevDockIcon(): void {
  if (!isDev || process.platform !== 'darwin' || !app.dock) return
  const icon = join(projectRoot, 'build-resources', 'icon.png')
  if (!existsSync(icon)) return
  try {
    app.dock.setIcon(icon)
  } catch {
    // Cosmetic only — a dev run without its Dock icon is not worth
    // failing startup over.
  }
}

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

/**
 * Clamp a remembered window position back onto a display that still
 * exists. Restoring raw stored coordinates strands the window off-screen
 * for anyone who undocks an external monitor between launches — with a
 * hidden titlebar there is then no visible chrome to drag it back with.
 */
function visibleBounds(state: store.WindowState): { width: number; height: number; x?: number; y?: number } {
  const width = Math.max(960, Math.round(state.width))
  const height = Math.max(600, Math.round(state.height))
  if (state.x === undefined || state.y === undefined) return { width, height }

  const displays = screen.getAllDisplays()
  const onScreen = displays.some((d) => {
    const a = d.workArea
    // At least a 100x40 grab handle's worth of the titlebar has to land
    // inside a work area for the window to be reachable.
    return (
      state.x! + width > a.x + 100 &&
      state.x! < a.x + a.width - 100 &&
      state.y! + 40 > a.y &&
      state.y! < a.y + a.height - 40
    )
  })
  return onScreen ? { width, height, x: Math.round(state.x), y: Math.round(state.y) } : { width, height }
}

function createWindow(): BrowserWindow {
  const saved = store.getWindowState()
  const bounds = saved ? visibleBounds(saved) : { width: 1280, height: 820 }

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    // The sidebar now runs the full height of the window and owns the
    // traffic-light inset itself (see Sidebar.tsx), so this y only has to
    // agree with the spacer the sidebar reserves.
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })

  if (saved?.maximized) win.maximize()

  win.on('ready-to-show', () => win.show())

  // Debounced: 'resize' and 'move' fire per frame while dragging, and a
  // synchronous JSON write per frame would make dragging the window
  // stutter.
  let persistTimer: NodeJS.Timeout | null = null
  const persist = (): void => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      if (win.isDestroyed()) return
      const maximized = win.isMaximized()
      // getNormalBounds() rather than getBounds(): while maximized the
      // latter reports the screen, so saving it would make "restore down"
      // a no-op forever after.
      const b = win.getNormalBounds()
      store.setWindowState({ width: b.width, height: b.height, x: b.x, y: b.y, maximized })
    }, 400)
  }
  win.on('resize', persist)
  win.on('move', persist)
  win.on('maximize', persist)
  win.on('unmaximize', persist)
  win.on('close', () => {
    if (persistTimer) clearTimeout(persistTimer)
  })

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

  ipcMain.handle(IPC.API_LIST_BOOKMARKS, (_e, params: { limit?: number; cursor?: string } & BookmarkListFilter) =>
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
  ipcMain.handle(IPC.API_GET_BOOKMARK, (_e, id: string) => requireClient().getBookmark(id))
  ipcMain.handle(IPC.API_GET_BOOKMARK_LISTS, (_e, bookmarkId: string) =>
    requireClient().getBookmarkLists(bookmarkId)
  )
  ipcMain.handle(IPC.API_GET_ASSET, (_e, assetId: string) => requireClient().getAssetDataUrl(assetId))
  ipcMain.handle(IPC.API_GET_ASSET_BYTES, (_e, assetId: string) => requireClient().getAssetBytes(assetId))

  ipcMain.handle(
    IPC.API_CREATE_HIGHLIGHT,
    (
      _e,
      input: { bookmarkId: string; startOffset: number; endOffset: number; color?: string; text?: string; note?: string }
    ) => requireClient().createHighlight(input)
  )
  ipcMain.handle(IPC.API_UPDATE_HIGHLIGHT, (_e, args: { id: string; input: { color?: string; note?: string } }) =>
    requireClient().updateHighlight(args.id, args.input)
  )
  ipcMain.handle(IPC.API_DELETE_HIGHLIGHT, (_e, id: string) => requireClient().deleteHighlight(id))

  ipcMain.handle(IPC.API_CREATE_BOOKMARK, (_e, input: CreateBookmarkInput) => requireClient().createBookmark(input))
  ipcMain.handle(IPC.API_UPDATE_BOOKMARK, (_e, args: { id: string; input: UpdateBookmarkInput }) =>
    requireClient().updateBookmark(args.id, args.input)
  )
  ipcMain.handle(IPC.API_DELETE_BOOKMARK, (_e, id: string) => requireClient().deleteBookmark(id))
  ipcMain.handle(IPC.API_UPLOAD_ASSET, (_e, input: AssetUploadInput) => requireClient().uploadAsset(input))
  ipcMain.handle(IPC.API_CREATE_LIST, (_e, input: CreateListInput) => requireClient().createList(input))
  ipcMain.handle(IPC.API_UPDATE_LIST, (_e, args: { id: string; input: UpdateListInput }) =>
    requireClient().updateList(args.id, args.input)
  )
  ipcMain.handle(IPC.API_DELETE_LIST, (_e, id: string) => requireClient().deleteList(id))
  ipcMain.handle(IPC.API_ADD_BOOKMARK_TO_LIST, (_e, args: { listId: string; bookmarkId: string }) =>
    requireClient().addBookmarkToList(args.listId, args.bookmarkId)
  )
  ipcMain.handle(IPC.API_REMOVE_BOOKMARK_FROM_LIST, (_e, args: { listId: string; bookmarkId: string }) =>
    requireClient().removeBookmarkFromList(args.listId, args.bookmarkId)
  )
  ipcMain.handle(IPC.API_UPDATE_TAG, (_e, args: { id: string; input: UpdateTagInput }) =>
    requireClient().updateTag(args.id, args.input)
  )
  ipcMain.handle(IPC.API_DELETE_TAG, (_e, id: string) => requireClient().deleteTag(id))
  ipcMain.handle(IPC.API_ATTACH_TAGS, (_e, args: { bookmarkId: string; tagNames: string[] }) =>
    requireClient().attachTagsToBookmark(args.bookmarkId, args.tagNames)
  )
  ipcMain.handle(IPC.API_DETACH_TAGS, (_e, args: { bookmarkId: string; tagNames: string[] }) =>
    requireClient().detachTagsFromBookmark(args.bookmarkId, args.tagNames)
  )

  ipcMain.handle(IPC.STORE_GET_LIST_ORDER, () => store.getListOrder())
  ipcMain.handle(IPC.STORE_SET_LIST_ORDER, (_e, order: ListOrder) => {
    store.setListOrder(order)
  })

  // ─────────────────────────── Gemini AI handlers ───────────────────────────
  ipcMain.handle(IPC.AI_SET_CONFIG, (_e, input: { geminiApiKey?: string; geminiModel?: string }) => {
    store.setAiConfig(input)
    return store.getConfig()
  })

  ipcMain.handle(IPC.AI_TEST_CONNECTION, async (_e, input?: { apiKey?: string; model?: string }) => {
    return aiService.testConnection(input?.apiKey, input?.model)
  })

  ipcMain.handle(IPC.AI_STREAM_ABORT, (_e, requestId: string) => {
    aiService.abort(requestId)
  })

  ipcMain.handle(IPC.AI_STREAM_START, async (event, req: AiStreamRequest) => {
    const sender = event.sender
    try {
      const fullText = await aiService.streamRequest(req, (delta) => {
        if (!sender.isDestroyed()) {
          sender.send(IPC.AI_STREAM_CHUNK_EVENT, { requestId: req.requestId, delta })
        }
      })
      if (!sender.isDestroyed()) {
        sender.send(IPC.AI_STREAM_DONE_EVENT, { requestId: req.requestId, fullText })
      }
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!sender.isDestroyed()) {
        sender.send(IPC.AI_STREAM_ERROR_EVENT, { requestId: req.requestId, error: message })
      }
      return { ok: false, error: message }
    }
  })

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

/**
 * Dev-only: drive the PDF pane end to end against the configured instance.
 *
 * Set KK_SMOKE=1, KK_SMOKE_PDF=1 and KK_SMOKE_BOOKMARK=<id of a PDF bookmark>.
 * The run selects that bookmark, waits for the pane to finish indexing the
 * document's text, creates a highlight through the same code path the
 * selection toolbar uses, screenshots the result — and then deletes the
 * highlight it made, printing both ids so the count can be checked to balance.
 */
async function runPdfSmokeMode(win: BrowserWindow): Promise<void> {
  // In a packaged build projectRoot points inside the asar, which is not
  // writable — this mode is also used to check that the packaged renderer can
  // load the pdfium wasm and its worker over file://.
  const dir = app.isPackaged ? join(app.getPath('temp'), 'kk-smoke') : join(projectRoot, 'tmp-screenshots')
  mkdirSync(dir, { recursive: true })

  async function shot(name: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 700))
    win.webContents.invalidate()
    await new Promise((r) => setTimeout(r, 400))
    const image = await win.webContents.capturePage()
    writeFileSync(join(dir, name), image.toPNG())
    console.log('[smoke-pdf] saved', name)
  }

  // Renderer console output is otherwise invisible to the driving shell.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[smoke-pdf] renderer gone:', JSON.stringify(details))
  })

  // Real mouse input into the window, so the smoke exercises the pointer
  // path the interaction manager actually listens on.
  // Real OS-level input. Chromium coalesces these badly, so they are useless
  // for driving a selection — but one press-and-move is all it takes to start
  // a native image drag, which is the one failure synthetic PointerEvents
  // structurally cannot reproduce.
  ipcMain.handle('dev:smoke-pdf-real-input', async (_e, at: { x: number; y: number }) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 40))
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: at.x + 60,
      y: at.y + 20,
      button: 'left',
      modifiers: ['leftButtonDown']
    })
    await new Promise((r) => setTimeout(r, 120))
    win.webContents.sendInputEvent({ type: 'mouseUp', x: at.x + 60, y: at.y + 20, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 150))
  })

  ipcMain.handle('dev:smoke-pdf-real-click', async (_e, at: { x: number; y: number }) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 90))
    win.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 200))
  })

  const pdfReady = new Promise<void>((resolve) => ipcMain.once('dev:smoke-pdf-ready', () => resolve()))
  const highlighted = new Promise<string>((resolve) =>
    ipcMain.once('dev:smoke-pdf-highlighted', (_e, id: string) => resolve(id))
  )

  const safety = setTimeout(() => {
    console.error('[smoke-pdf] timeout reached, quitting')
    // Capture what the app was actually showing when it stalled — otherwise a
    // timeout tells you nothing about where it got stuck.
    void shot('pdf-timeout.png').finally(() => app.quit())
  }, 60000)

  // Highlights that were already on the bookmark before this run. Without
  // this the cleanup check compares against zero and reports the user's own
  // highlights as leftovers of the test.
  let preexisting: string[] = []
  try {
    preexisting = (await requireClient().getBookmarkHighlights(process.env['KK_SMOKE_BOOKMARK'] || '')).map(
      (h) => h.id
    )
    console.log('[smoke-pdf] highlights already on the bookmark:', preexisting.length)
  } catch {
    console.log('[smoke-pdf] could not read the bookmark before the run')
  }

  await new Promise((r) => setTimeout(r, 1500))
  win.webContents.send('dev:smoke-start')

  await pdfReady
  await shot('pdf-01-rendered.png')

  win.webContents.send('dev:smoke-pdf-highlight')
  const createdId = await highlighted
  console.log('[smoke-pdf] created highlight id:', createdId || '(none)')
  await shot('pdf-02-highlighted.png')

  // Clean up through the renderer's own delete path, so that path is
  // exercised too, then confirm against the server that nothing is left.
  if (createdId) {
    const cleaned = new Promise<boolean>((resolve) =>
      ipcMain.once('dev:smoke-pdf-cleaned', (_e, ok: boolean) => resolve(ok))
    )
    win.webContents.send('dev:smoke-pdf-cleanup', createdId)
    console.log('[smoke-pdf] renderer delete reported ok:', await cleaned)
    try {
      const remaining = await requireClient().getBookmarkHighlights(process.env['KK_SMOKE_BOOKMARK'] || '')
      const mine = remaining.filter((h) => !preexisting.includes(h.id))
      console.log(
        `[smoke-pdf] highlights on bookmark: ${remaining.length} (${preexisting.length} pre-existing, ${mine.length} left by this run)`
      )
      if (mine.length > 0) {
        console.error('[smoke-pdf] LEFTOVERS:', mine.map((h) => h.id).join(', '))
      }
    } catch (err) {
      console.error('[smoke-pdf] could not verify cleanup', err instanceof Error ? err.message : err)
    }
  }

  clearTimeout(safety)
  if (process.env['KK_SMOKE_HOLD'] === '1') {
    console.log('[smoke-pdf] KK_SMOKE_HOLD=1 — leaving window open')
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
      void (process.env['KK_SMOKE_PDF'] === '1' ? runPdfSmokeMode(win) : runSmokeMode(win, pane))
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
  // .env.local is a dev convenience and only exists in a source checkout; a
  // packaged build can still be pointed at an instance through the process
  // environment. Either way this only applies when nothing is stored yet.
  const env = loadDotEnvLocal(projectRoot)
  store.seedFromEnvIfEmpty({
    KARAKEEP_BASE_URL: env['KARAKEEP_BASE_URL'] || process.env['KARAKEEP_BASE_URL'],
    KARAKEEP_API_KEY: env['KARAKEEP_API_KEY'] || process.env['KARAKEEP_API_KEY']
  })
  apiClient = makeClientFromStore()

  setDevDockIcon()

  Menu.setApplicationMenu(
    buildAppMenu(() => BrowserWindow.getFocusedWindow() || mainWindow)
  )

  initWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) initWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
