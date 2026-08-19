// Channel name constants shared between main and renderer/preload.
export const IPC = {
  // Config / auth
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_SIGN_OUT: 'config:sign-out',
  AUTH_TEST: 'auth:test',

  // API (proxied through main so the API key never enters the renderer)
  API_LIST_BOOKMARKS: 'api:list-bookmarks',
  API_SEARCH_BOOKMARKS: 'api:search-bookmarks',
  API_GET_LISTS: 'api:get-lists',
  API_GET_TAGS: 'api:get-tags',
  API_GET_HIGHLIGHTS: 'api:get-highlights',
  API_GET_ASSET: 'api:get-asset',

  // Window chrome
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',

  // Web pane (WebContentsView)
  WEBPANE_NAVIGATE: 'webpane:navigate',
  WEBPANE_SET_BOUNDS: 'webpane:set-bounds',
  WEBPANE_SHOW: 'webpane:show',
  WEBPANE_HIDE: 'webpane:hide',
  WEBPANE_DESTROY: 'webpane:destroy',
  WEBPANE_BACK: 'webpane:back',
  WEBPANE_FORWARD: 'webpane:forward',
  WEBPANE_RELOAD: 'webpane:reload',
  WEBPANE_STOP: 'webpane:stop',
  WEBPANE_OPEN_EXTERNAL: 'webpane:open-external',
  WEBPANE_STATE_EVENT: 'webpane:state', // main -> renderer push
  WEBPANE_HIGHLIGHTS_CHANGED_EVENT: 'webpane:highlights-changed' // main -> renderer push
} as const

export const WEBPANE_IPC = {
  READY: 'kk:ready',
  APPLY: 'kk:apply', // main -> webpane: apply stored highlights
  HIGHLIGHT_CREATED: 'kk:highlight-created', // webpane -> main
  HIGHLIGHT_UPDATED: 'kk:highlight-updated', // webpane -> main
  HIGHLIGHT_REMOVED: 'kk:highlight-removed' // webpane -> main
} as const
