/**
 * The message protocol between the service worker, the content script and
 * the popup. Every request goes through chrome.runtime.sendMessage and gets a
 * `Reply` back; the worker is the only side that talks to Karakeep.
 */
import type { Bookmark, Highlight, KKList, KKTag, UpdateBookmarkInput, User } from '../../src/shared/types'

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string }

/** What the content script sends when it creates a highlight. */
export interface NewHighlight {
  text: string
  color: string
  note: string
  startOffset: number
  endOffset: number
}

export type Request =
  // content script
  | { type: 'page:init'; url: string }
  | { type: 'highlight:create'; url: string; title: string; highlight: NewHighlight }
  | { type: 'highlight:update'; id: string; color?: string; note?: string }
  | { type: 'highlight:delete'; id: string }
  // popup
  | { type: 'popup:state'; tabId: number }
  | { type: 'bookmark:save'; tabId: number }
  | { type: 'bookmark:update'; tabId: number; id: string; patch: UpdateBookmarkInput }
  | { type: 'bookmark:delete'; tabId: number; id: string }
  | { type: 'tags:attach'; id: string; names: string[] }
  | { type: 'tags:detach'; id: string; names: string[] }
  | { type: 'lists:add'; listId: string; id: string }
  | { type: 'lists:remove'; listId: string; id: string }
  | { type: 'popup:delete-highlight'; tabId: number; id: string }
  // options
  | { type: 'config:test'; baseUrl: string; apiKey: string; customHeaders: Record<string, string> }
  | { type: 'ai:test'; geminiApiKey: string; geminiModel: string }

export interface PageInit {
  configured: boolean
  showHighlights: boolean
  bookmarkId: string | null
  highlights: Highlight[]
}

export interface CreatedHighlight {
  serverId: string
  bookmarkId: string
  /** True when this highlight is what saved the page to Karakeep. */
  createdBookmark: boolean
}

export interface PopupState {
  configured: boolean
  baseUrl: string
  user: User | null
  tab: { id: number; url: string; title: string; favIconUrl?: string; savable: boolean }
  bookmark: Bookmark | null
  highlights: Highlight[]
  lists: KKList[]
  bookmarkLists: KKList[]
  tags: KKTag[]
  aiConfigured: boolean
}

/** Worker -> content script, via chrome.tabs.sendMessage. */
export type TabMessage =
  | { type: 'kk:open-toolbar' }
  | { type: 'kk:remove'; id: string }
  | { type: 'kk:clear' }
  | { type: 'kk:focus'; id: string }
  | { type: 'kk:toast'; text: string }

/** Port protocol for streamed AI answers (port name `kk-ai`). */
export type AiPortIn = { type: 'start'; request: import('../../src/shared/types').AiStreamRequest }
export type AiPortOut =
  | { type: 'chunk'; delta: string }
  | { type: 'done'; fullText: string }
  | { type: 'error'; error: string }

export const AI_PORT = 'kk-ai'

export async function send<T>(req: Request): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(req)) as Reply<T> | undefined
  if (!reply) throw new Error('The Karakeep extension did not answer. Try reloading the page.')
  if (!reply.ok) throw new Error(reply.error)
  return reply.data
}
