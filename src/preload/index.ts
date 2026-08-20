import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AppConfig,
  AuthResult,
  Bookmark,
  BookmarksPage,
  CreateBookmarkInput,
  CreateHighlightInput,
  CreateListInput,
  Highlight,
  KKList,
  KKTag,
  ListOrder,
  UpdateListInput,
  UpdateTagInput,
  WebPaneBounds,
  WebPaneState
} from '../shared/types'

const api = {
  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.CONFIG_GET),
    set: (input: { baseUrl: string; apiKey: string; customHeaders?: Record<string, string> }): Promise<AppConfig> =>
      ipcRenderer.invoke(IPC.CONFIG_SET, input),
    signOut: (): Promise<void> => ipcRenderer.invoke(IPC.CONFIG_SIGN_OUT)
  },
  auth: {
    test: (): Promise<AuthResult> => ipcRenderer.invoke(IPC.AUTH_TEST)
  },
  bookmarks: {
    list: (params: { limit?: number; cursor?: string }): Promise<BookmarksPage> =>
      ipcRenderer.invoke(IPC.API_LIST_BOOKMARKS, params),
    search: (params: { q: string; limit?: number; cursor?: string }): Promise<BookmarksPage> =>
      ipcRenderer.invoke(IPC.API_SEARCH_BOOKMARKS, params),
    create: (input: CreateBookmarkInput): Promise<Bookmark> => ipcRenderer.invoke(IPC.API_CREATE_BOOKMARK, input)
  },
  lists: {
    get: (): Promise<KKList[]> => ipcRenderer.invoke(IPC.API_GET_LISTS),
    getBookmarks: (listId: string, params: { limit?: number; cursor?: string }): Promise<BookmarksPage> =>
      ipcRenderer.invoke(IPC.API_GET_LIST_BOOKMARKS, { listId, ...params }),
    create: (input: CreateListInput): Promise<KKList> => ipcRenderer.invoke(IPC.API_CREATE_LIST, input),
    update: (id: string, input: UpdateListInput): Promise<KKList> =>
      ipcRenderer.invoke(IPC.API_UPDATE_LIST, { id, input }),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.API_DELETE_LIST, id),
    addBookmark: (listId: string, bookmarkId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.API_ADD_BOOKMARK_TO_LIST, { listId, bookmarkId }),
    removeBookmark: (listId: string, bookmarkId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.API_REMOVE_BOOKMARK_FROM_LIST, { listId, bookmarkId })
  },
  tags: {
    get: (): Promise<KKTag[]> => ipcRenderer.invoke(IPC.API_GET_TAGS),
    getBookmarks: (tagId: string, params: { limit?: number; cursor?: string }): Promise<BookmarksPage> =>
      ipcRenderer.invoke(IPC.API_GET_TAG_BOOKMARKS, { tagId, ...params }),
    update: (id: string, input: UpdateTagInput): Promise<KKTag> => ipcRenderer.invoke(IPC.API_UPDATE_TAG, { id, input }),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.API_DELETE_TAG, id),
    attach: (bookmarkId: string, tagNames: string[]): Promise<void> =>
      ipcRenderer.invoke(IPC.API_ATTACH_TAGS, { bookmarkId, tagNames }),
    detach: (bookmarkId: string, tagNames: string[]): Promise<void> =>
      ipcRenderer.invoke(IPC.API_DETACH_TAGS, { bookmarkId, tagNames })
  },
  store: {
    getListOrder: (): Promise<ListOrder> => ipcRenderer.invoke(IPC.STORE_GET_LIST_ORDER),
    setListOrder: (order: ListOrder): Promise<void> => ipcRenderer.invoke(IPC.STORE_SET_LIST_ORDER, order)
  },
  highlights: {
    get: (params: { cursor?: string; limit?: number }): Promise<{ highlights: Highlight[]; nextCursor?: string | null }> =>
      ipcRenderer.invoke(IPC.API_GET_HIGHLIGHTS, params),
    forBookmark: (bookmarkId: string): Promise<Highlight[]> =>
      ipcRenderer.invoke(IPC.API_GET_BOOKMARK_HIGHLIGHTS, bookmarkId),
    create: (input: CreateHighlightInput): Promise<Highlight> => ipcRenderer.invoke(IPC.API_CREATE_HIGHLIGHT, input),
    update: (id: string, input: { color?: string; note?: string }): Promise<Highlight> =>
      ipcRenderer.invoke(IPC.API_UPDATE_HIGHLIGHT, { id, input }),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.API_DELETE_HIGHLIGHT, id)
  },
  assets: {
    get: (assetId: string): Promise<string> => ipcRenderer.invoke(IPC.API_GET_ASSET, assetId),
    getBytes: (assetId: string): Promise<ArrayBuffer> => ipcRenderer.invoke(IPC.API_GET_ASSET_BYTES, assetId)
  },
  window: {
    minimize: (): void => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
    maximize: (): void => ipcRenderer.send(IPC.WINDOW_MAXIMIZE),
    close: (): void => ipcRenderer.send(IPC.WINDOW_CLOSE),
    onToggleSidebar: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.MENU_TOGGLE_SIDEBAR_EVENT, listener)
      return () => ipcRenderer.removeListener(IPC.MENU_TOGGLE_SIDEBAR_EVENT, listener)
    },
    onToggleList: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.MENU_TOGGLE_LIST_EVENT, listener)
      return () => ipcRenderer.removeListener(IPC.MENU_TOGGLE_LIST_EVENT, listener)
    },
    onToggleFocusMode: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.MENU_TOGGLE_FOCUS_MODE_EVENT, listener)
      return () => ipcRenderer.removeListener(IPC.MENU_TOGGLE_FOCUS_MODE_EVENT, listener)
    }
  },
  webpane: {
    navigate: (url: string, bookmarkId: string, highlights: Highlight[]): Promise<void> =>
      ipcRenderer.invoke(IPC.WEBPANE_NAVIGATE, { url, bookmarkId, highlights }),
    applyHighlights: (highlights: Highlight[]): Promise<void> =>
      ipcRenderer.invoke(IPC.WEBPANE_APPLY_HIGHLIGHTS, { highlights }),
    focusHighlight: (highlightId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.WEBPANE_FOCUS_HIGHLIGHT, highlightId),
    setBounds: (bounds: WebPaneBounds): Promise<void> => ipcRenderer.invoke(IPC.WEBPANE_SET_BOUNDS, bounds),
    show: (): Promise<void> => ipcRenderer.invoke(IPC.WEBPANE_SHOW),
    hide: (): Promise<void> => ipcRenderer.invoke(IPC.WEBPANE_HIDE),
    destroy: (): Promise<void> => ipcRenderer.invoke(IPC.WEBPANE_DESTROY),
    back: (): Promise<void> => ipcRenderer.invoke(IPC.WEBPANE_BACK),
    forward: (): Promise<void> => ipcRenderer.invoke(IPC.WEBPANE_FORWARD),
    reload: (): Promise<void> => ipcRenderer.invoke(IPC.WEBPANE_RELOAD),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.WEBPANE_STOP),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.WEBPANE_OPEN_EXTERNAL, url),
    onState: (cb: (state: WebPaneState) => void): (() => void) => {
      const listener = (_e: unknown, state: WebPaneState): void => cb(state)
      ipcRenderer.on(IPC.WEBPANE_STATE_EVENT, listener)
      return () => ipcRenderer.removeListener(IPC.WEBPANE_STATE_EVENT, listener)
    },
    onHighlightsChanged: (cb: (payload: { bookmarkId: string }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { bookmarkId: string }): void => cb(payload)
      ipcRenderer.on(IPC.WEBPANE_HIGHLIGHTS_CHANGED_EVENT, listener)
      return () => ipcRenderer.removeListener(IPC.WEBPANE_HIGHLIGHTS_CHANGED_EVENT, listener)
    },
    onHighlightStatus: (
      cb: (payload: { bookmarkId: string | null; anchored: string[]; missing: string[] }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        payload: { bookmarkId: string | null; anchored: string[]; missing: string[] }
      ): void => cb(payload)
      ipcRenderer.on(IPC.WEBPANE_HIGHLIGHT_STATUS_EVENT, listener)
      return () => ipcRenderer.removeListener(IPC.WEBPANE_HIGHLIGHT_STATUS_EVENT, listener)
    }
  },
  dev: {
    isSmoke: process.env['KK_SMOKE'] === '1',
    onSmokeStart: (cb: () => void): void => {
      ipcRenderer.on('dev:smoke-start', () => cb())
    },
    onSwitchToWeb: (cb: () => void): void => {
      ipcRenderer.on('dev:smoke-switch-to-web', () => cb())
    },
    onSelectList: (cb: () => void): void => {
      ipcRenderer.on('dev:smoke-select-list', () => cb())
    },
    // Smoke-only: which bookmark to auto-select, and the PDF pane's own
    // ready/act handshake. Lets the smoke run exercise the real user path
    // (select text -> create highlight) instead of a stubbed one.
    smokeBookmarkId: process.env['KK_SMOKE_BOOKMARK'] || null,
    notifyPdfReady: (): void => ipcRenderer.send('dev:smoke-pdf-ready'),
    notifyPdfHighlighted: (id: string): void => ipcRenderer.send('dev:smoke-pdf-highlighted', id),
    onPdfHighlight: (cb: () => void): void => {
      ipcRenderer.on('dev:smoke-pdf-highlight', () => cb())
    },
    onPdfCleanup: (cb: (id: string) => void): void => {
      ipcRenderer.on('dev:smoke-pdf-cleanup', (_e, id: string) => cb(id))
    },
    notifyPdfCleaned: (ok: boolean): void => ipcRenderer.send('dev:smoke-pdf-cleaned', ok),
    realInputOnPdf: (at: { x: number; y: number }): Promise<void> =>
      ipcRenderer.invoke('dev:smoke-pdf-real-input', at),
    realClickOnPdf: (at: { x: number; y: number }): Promise<void> =>
      ipcRenderer.invoke('dev:smoke-pdf-real-click', at),
    notifyDetailReady: (): void => ipcRenderer.send('dev:smoke-detail-ready'),
    notifyWebReady: (): void => ipcRenderer.send('dev:smoke-web-ready'),
    notifyListReady: (): void => ipcRenderer.send('dev:smoke-list-ready'),
    // Diagnostic-only: confirms the WebContentsView was actually removed
    // from the window's contentView, not just resized to zero / covered.
    isPaneAttached: (): Promise<boolean> => ipcRenderer.invoke(IPC.WEBPANE_IS_ATTACHED)
  }
}

export type KarakeepPreloadApi = typeof api

contextBridge.exposeInMainWorld('kk', api)
