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
  API_GET_BOOKMARK_HIGHLIGHTS: 'api:get-bookmark-highlights',
  API_GET_LIST_BOOKMARKS: 'api:get-list-bookmarks',
  API_GET_TAG_BOOKMARKS: 'api:get-tag-bookmarks',
  API_GET_ASSET: 'api:get-asset',
  API_GET_ASSET_BYTES: 'api:get-asset-bytes', // raw bytes (PDFs) — data URLs are wasteful at book size

  API_GET_BOOKMARK: 'api:get-bookmark',
  API_GET_BOOKMARK_LISTS: 'api:get-bookmark-lists',

  // Writes
  API_CREATE_BOOKMARK: 'api:create-bookmark',
  API_UPDATE_BOOKMARK: 'api:update-bookmark',
  API_DELETE_BOOKMARK: 'api:delete-bookmark',
  API_UPLOAD_ASSET: 'api:upload-asset',
  API_CREATE_LIST: 'api:create-list',
  API_UPDATE_LIST: 'api:update-list',
  API_DELETE_LIST: 'api:delete-list',
  API_ADD_BOOKMARK_TO_LIST: 'api:add-bookmark-to-list',
  API_REMOVE_BOOKMARK_FROM_LIST: 'api:remove-bookmark-from-list',
  API_UPDATE_TAG: 'api:update-tag',
  API_DELETE_TAG: 'api:delete-tag',
  API_ATTACH_TAGS: 'api:attach-tags',
  API_DETACH_TAGS: 'api:detach-tags',

  // Highlights, written straight from the renderer. The Web pane's highlights
  // travel a different road (preload -> main), because there the selection
  // lives inside another process's DOM; in the PDF pane the selection is in
  // this renderer, so it talks to the API directly.
  API_CREATE_HIGHLIGHT: 'api:create-highlight',
  API_UPDATE_HIGHLIGHT: 'api:update-highlight',
  API_DELETE_HIGHLIGHT: 'api:delete-highlight',

  // Local-only persisted state (see shared/types.ts ListOrder)
  STORE_GET_LIST_ORDER: 'store:get-list-order',
  STORE_SET_LIST_ORDER: 'store:set-list-order',

  // Window chrome
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',

  // View menu -> renderer pushes. The renderer owns sidebar/list-collapse
  // state (persisted in localStorage, see App.tsx); main just tells it
  // which toggle was invoked from the menu/shortcut.
  MENU_TOGGLE_SIDEBAR_EVENT: 'menu:toggle-sidebar',
  MENU_TOGGLE_LIST_EVENT: 'menu:toggle-list',
  MENU_TOGGLE_FOCUS_MODE_EVENT: 'menu:toggle-focus-mode',
  MENU_NEW_BOOKMARK_EVENT: 'menu:new-bookmark',
  MENU_FOCUS_SEARCH_EVENT: 'menu:focus-search',
  MENU_OPEN_SETTINGS_EVENT: 'menu:open-settings',

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
  WEBPANE_IS_ATTACHED: 'webpane:is-attached', // dev/smoke diagnostic — confirms actual detach, not just visual hide
  WEBPANE_APPLY_HIGHLIGHTS: 'webpane:apply-highlights', // re-push highlights without re-navigating
  WEBPANE_FOCUS_HIGHLIGHT: 'webpane:focus-highlight', // scroll a highlight into view in the live page
  WEBPANE_STATE_EVENT: 'webpane:state', // main -> renderer push
  WEBPANE_HIGHLIGHTS_CHANGED_EVENT: 'webpane:highlights-changed', // main -> renderer push
  WEBPANE_HIGHLIGHT_STATUS_EVENT: 'webpane:highlight-status' // main -> renderer push: which highlights anchored
} as const

export const WEBPANE_IPC = {
  READY: 'kk:ready',
  APPLY: 'kk:apply', // main -> webpane: apply stored highlights
  HIGHLIGHT_CREATED: 'kk:highlight-created', // webpane -> main
  HIGHLIGHT_UPDATED: 'kk:highlight-updated', // webpane -> main
  HIGHLIGHT_REMOVED: 'kk:highlight-removed', // webpane -> main
  FOCUS: 'kk:focus', // main -> webpane: scroll+flash one highlight
  ID_ASSIGNED: 'kk:id-assigned', // main -> webpane: client id -> server id
  STATUS: 'kk:highlight-status' // webpane -> main: anchored / missing ids
} as const
