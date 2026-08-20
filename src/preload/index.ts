import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AppConfig,
  AuthResult,
  BookmarksPage,
  Highlight,
  KKList,
  KKTag,
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
      ipcRenderer.invoke(IPC.API_SEARCH_BOOKMARKS, params)
  },
  lists: {
    get: (): Promise<KKList[]> => ipcRenderer.invoke(IPC.API_GET_LISTS),
    getBookmarks: (listId: string, params: { limit?: number; cursor?: string }): Promise<BookmarksPage> =>
      ipcRenderer.invoke(IPC.API_GET_LIST_BOOKMARKS, { listId, ...params })
  },
  tags: {
    get: (): Promise<KKTag[]> => ipcRenderer.invoke(IPC.API_GET_TAGS),
    getBookmarks: (tagId: string, params: { limit?: number; cursor?: string }): Promise<BookmarksPage> =>
      ipcRenderer.invoke(IPC.API_GET_TAG_BOOKMARKS, { tagId, ...params })
  },
  highlights: {
    get: (params: { cursor?: string; limit?: number }): Promise<{ highlights: Highlight[]; nextCursor?: string | null }> =>
      ipcRenderer.invoke(IPC.API_GET_HIGHLIGHTS, params),
    forBookmark: (bookmarkId: string): Promise<Highlight[]> =>
      ipcRenderer.invoke(IPC.API_GET_BOOKMARK_HIGHLIGHTS, bookmarkId)
  },
  assets: {
    get: (assetId: string): Promise<string> => ipcRenderer.invoke(IPC.API_GET_ASSET, assetId)
  },
  window: {
    minimize: (): void => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
    maximize: (): void => ipcRenderer.send(IPC.WINDOW_MAXIMIZE),
    close: (): void => ipcRenderer.send(IPC.WINDOW_CLOSE)
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
