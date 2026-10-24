/**
 * The extension's service worker: the only part that talks to Karakeep or to
 * Gemini. Content scripts and the popup reach it through the message
 * protocol in messages.ts.
 *
 * It also owns the two ways into the highlight toolbar — the "Highlight with
 * Karakeep" context-menu entry and the keyboard shortcut. The toolbar is
 * deliberately not opened on every text selection the way the desktop
 * reader does it: on the open web, people select text constantly for reasons
 * that have nothing to do with highlighting.
 */
import { KarakeepApi } from './api'
import { streamAnswer, testGemini } from './ai'
import {
  AI_PORT,
  type AiPortIn,
  type AiPortOut,
  type CreatedHighlight,
  type PageInit,
  type PopupState,
  type Reply,
  type Request,
  type TabMessage
} from './messages'
import { getSettings, isConfigured } from './settings'

const MENU_HIGHLIGHT = 'kk-highlight'
const MENU_SAVE_PAGE = 'kk-save-page'
const MENU_SAVE_LINK = 'kk-save-link'
const BADGE_COLOR = '#059669'

async function api(): Promise<KarakeepApi> {
  const s = await getSettings()
  return new KarakeepApi({ baseUrl: s.baseUrl, apiKey: s.apiKey, customHeaders: s.customHeaders })
}

function isSavableUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url)
}

// ───────────────────────── badge ─────────────────────────

async function setBadge(tabId: number | undefined, bookmarkId: string | null, count: number): Promise<void> {
  if (tabId === undefined || tabId < 0) return
  try {
    if (!bookmarkId) {
      await chrome.action.setBadgeText({ tabId, text: '' })
      await chrome.action.setTitle({ tabId, title: 'Karakeep' })
      return
    }
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR })
    await chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' })
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '✓' })
    const what = count === 1 ? '1 highlight' : `${count} highlights`
    await chrome.action.setTitle({ tabId, title: `Saved in Karakeep · ${what}` })
  } catch {
    // The tab closed under us.
  }
}

async function refreshBadge(tabId: number | undefined, url: string): Promise<void> {
  const client = await api()
  const bookmarkId = await client.checkUrl(url)
  const count = bookmarkId ? (await client.getBookmarkHighlights(bookmarkId)).length : 0
  await setBadge(tabId, bookmarkId, count)
}

// ───────────────────────── tab messaging ─────────────────────────

/**
 * Sends to the tab's content script, injecting it first when the tab was
 * open before the extension was installed (declared content scripts only
 * reach pages loaded after that).
 */
async function sendToTab(tabId: number, msg: TabMessage): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, msg)
    return true
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
      await chrome.tabs.sendMessage(tabId, msg)
      return true
    } catch {
      return false
    }
  }
}

async function savePage(tabId: number, url: string, title?: string): Promise<string> {
  const client = await api()
  const bookmark = await client.createLinkBookmark(url, title)
  const highlights = await client.getBookmarkHighlights(bookmark.id)
  await setBadge(tabId, bookmark.id, highlights.length)
  return bookmark.id
}

// ───────────────────────── request handlers ─────────────────────────

async function handle(req: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (req.type) {
    case 'page:init': {
      const s = await getSettings()
      const init: PageInit = { configured: isConfigured(s), showHighlights: s.showHighlights, bookmarkId: null, highlights: [] }
      // With highlights off, page loads ask the server nothing at all: the
      // lookup is what sends each visited URL to Karakeep.
      if (!init.configured || !init.showHighlights || !isSavableUrl(req.url)) return init
      const client = await api()
      init.bookmarkId = await client.checkUrl(req.url)
      if (init.bookmarkId) init.highlights = await client.getBookmarkHighlights(init.bookmarkId)
      await setBadge(sender.tab?.id, init.bookmarkId, init.highlights.length)
      return init
    }

    case 'highlight:create': {
      // Highlighting a page that isn't saved yet saves it: a highlight has to
      // hang off a bookmark, and asking first would be one more prompt for
      // something the user has plainly already decided.
      const client = await api()
      let bookmarkId = await client.checkUrl(req.url)
      let createdBookmark = false
      if (!bookmarkId) {
        bookmarkId = (await client.createLinkBookmark(req.url, req.title || undefined)).id
        createdBookmark = true
      }
      const created = await client.createHighlight({ bookmarkId, ...req.highlight })
      const count = (await client.getBookmarkHighlights(bookmarkId)).length
      await setBadge(sender.tab?.id, bookmarkId, count)
      const out: CreatedHighlight = { serverId: created.id, bookmarkId, createdBookmark }
      return out
    }

    case 'highlight:update': {
      const client = await api()
      await client.updateHighlight(req.id, { color: req.color, note: req.note })
      return null
    }

    case 'highlight:delete': {
      const client = await api()
      await client.deleteHighlight(req.id)
      if (sender.tab?.url) await refreshBadge(sender.tab.id, sender.tab.url).catch(() => undefined)
      return null
    }

    case 'popup:state':
      return popupState(req.tabId)

    case 'bookmark:save': {
      const tab = await chrome.tabs.get(req.tabId)
      if (!isSavableUrl(tab.url)) throw new Error("This page can't be saved to Karakeep.")
      await savePage(req.tabId, tab.url, tab.title)
      return popupState(req.tabId)
    }

    case 'bookmark:update': {
      const client = await api()
      return client.updateBookmark(req.id, req.patch)
    }

    case 'bookmark:delete': {
      const client = await api()
      await client.deleteBookmark(req.id)
      await setBadge(req.tabId, null, 0)
      await sendToTab(req.tabId, { type: 'kk:clear' })
      return null
    }

    case 'tags:attach': {
      const client = await api()
      await client.attachTags(req.id, req.names)
      return client.getBookmark(req.id)
    }

    case 'tags:detach': {
      const client = await api()
      await client.detachTags(req.id, req.names)
      return client.getBookmark(req.id)
    }

    case 'lists:add': {
      const client = await api()
      await client.addToList(req.listId, req.id)
      return client.getBookmarkLists(req.id)
    }

    case 'lists:remove': {
      const client = await api()
      await client.removeFromList(req.listId, req.id)
      return client.getBookmarkLists(req.id)
    }

    case 'popup:delete-highlight': {
      const client = await api()
      await client.deleteHighlight(req.id)
      await sendToTab(req.tabId, { type: 'kk:remove', id: req.id })
      const tab = await chrome.tabs.get(req.tabId)
      if (tab.url) await refreshBadge(req.tabId, tab.url).catch(() => undefined)
      return null
    }

    case 'config:test': {
      const client = new KarakeepApi({ baseUrl: req.baseUrl, apiKey: req.apiKey, customHeaders: req.customHeaders })
      return client.getMe()
    }

    case 'ai:test': {
      const s = await getSettings()
      const result = await testGemini({ ...s, geminiApiKey: req.geminiApiKey, geminiModel: req.geminiModel })
      if (!result.ok) throw new Error(result.error || 'Gemini test failed')
      return result.model
    }
  }
}

async function popupState(tabId: number): Promise<PopupState> {
  const s = await getSettings()
  const tab = await chrome.tabs.get(tabId)
  const state: PopupState = {
    configured: isConfigured(s),
    baseUrl: s.baseUrl,
    user: null,
    tab: {
      id: tabId,
      url: tab.url || '',
      title: tab.title || tab.url || '',
      favIconUrl: tab.favIconUrl,
      savable: isSavableUrl(tab.url)
    },
    bookmark: null,
    highlights: [],
    lists: [],
    bookmarkLists: [],
    tags: [],
    aiConfigured: !!s.geminiApiKey
  }
  if (!state.configured) return state
  const client = await api()
  const [user, bookmarkId] = await Promise.all([
    client.getMe(),
    state.tab.savable ? client.checkUrl(state.tab.url) : Promise.resolve(null)
  ])
  state.user = user
  if (!bookmarkId) {
    await setBadge(tabId, null, 0)
    return state
  }
  const [bookmark, highlights, lists, bookmarkLists, tags] = await Promise.all([
    client.getBookmark(bookmarkId),
    client.getBookmarkHighlights(bookmarkId),
    client.getLists(),
    client.getBookmarkLists(bookmarkId),
    client.getTags()
  ])
  Object.assign(state, { bookmark, highlights, lists, bookmarkLists, tags })
  await setBadge(tabId, bookmarkId, highlights.length)
  return state
}

chrome.runtime.onMessage.addListener((req: Request, sender, sendResponse: (r: Reply<unknown>) => void) => {
  handle(req, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
  )
  return true // keeps the channel open for the async reply
})

// ───────────────────────── AI streaming ─────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== AI_PORT) return
  const controller = new AbortController()
  let closed = false
  const post = (m: AiPortOut): void => {
    if (!closed) port.postMessage(m)
  }
  port.onDisconnect.addListener(() => {
    closed = true
    controller.abort()
  })
  port.onMessage.addListener(async (msg: AiPortIn) => {
    if (msg.type !== 'start') return
    try {
      const settings = await getSettings()
      const fullText = await streamAnswer(settings, msg.request, (delta) => post({ type: 'chunk', delta }), controller.signal)
      post({ type: 'done', fullText })
    } catch (err) {
      if (controller.signal.aborted) return
      post({ type: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  })
})

// ───────────────────────── context menu & shortcuts ─────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    // With exactly one entry per context, Chrome shows it at the top level of
    // the menu instead of under a "Karakeep" submenu — one click, not two.
    chrome.contextMenus.create({ id: MENU_HIGHLIGHT, title: 'Highlight with Karakeep', contexts: ['selection'] })
    chrome.contextMenus.create({ id: MENU_SAVE_PAGE, title: 'Save page to Karakeep', contexts: ['page'] })
    chrome.contextMenus.create({ id: MENU_SAVE_LINK, title: 'Save link to Karakeep', contexts: ['link'] })
  })
  void getSettings().then((s) => {
    if (!isConfigured(s)) void chrome.runtime.openOptionsPage()
  })
})

async function toast(tabId: number, text: string): Promise<void> {
  await sendToTab(tabId, { type: 'kk:toast', text })
}

async function runSave(tabId: number, url: string | undefined, title?: string, isLink = false): Promise<void> {
  if (!isSavableUrl(url)) return
  try {
    if (isLink) {
      await (await api()).createLinkBookmark(url)
      await toast(tabId, 'Link saved to Karakeep')
    } else {
      await savePage(tabId, url, title)
      await toast(tabId, 'Saved to Karakeep')
    }
  } catch (err) {
    await toast(tabId, err instanceof Error ? err.message : String(err))
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return
  switch (info.menuItemId) {
    case MENU_HIGHLIGHT:
      void sendToTab(tab.id, { type: 'kk:open-toolbar' })
      break
    case MENU_SAVE_PAGE:
      void runSave(tab.id, tab.url, tab.title)
      break
    case MENU_SAVE_LINK:
      void runSave(tab.id, info.linkUrl, undefined, true)
      break
  }
})

chrome.commands.onCommand.addListener(async (command, tab) => {
  const target = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  if (!target?.id) return
  if (command === 'open-highlight-toolbar') void sendToTab(target.id, { type: 'kk:open-toolbar' })
  else if (command === 'save-page') void runSave(target.id, target.url, target.title)
})

chrome.tabs.onUpdated.addListener((tabId, change) => {
  // A navigation leaves the previous page's badge behind; the new page's
  // content script sets it again once it has asked the server.
  if (change.status === 'loading' && change.url) void setBadge(tabId, null, 0)
})
