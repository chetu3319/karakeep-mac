/**
 * Karakeep REST client for the extension's service worker.
 *
 * The subset of src/main/api.ts the extension needs, on plain fetch instead
 * of Electron's net.fetch. It runs only in the service worker: host
 * permissions exempt it from CORS there, and the API key never has to be
 * handed to a page.
 */
import {
  BookmarkSchema,
  HighlightsResponseSchema,
  ListsResponseSchema,
  TagsResponseSchema,
  UserSchema,
  type Bookmark,
  type Highlight,
  type KKList,
  type KKTag,
  type UpdateBookmarkInput,
  type User
} from '../../src/shared/types'
import { normalizeHighlightColor } from '../../src/shared/highlightUi'

const DEFAULT_TIMEOUT_MS = 15000

export interface ApiConfig {
  baseUrl: string
  apiKey: string
  customHeaders?: Record<string, string>
}

export class ApiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export class KarakeepApi {
  constructor(private config: ApiConfig) {}

  private async request<T>(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const { baseUrl, apiKey, customHeaders } = this.config
    if (!baseUrl || !apiKey) {
      throw new ApiError('Karakeep is not configured. Set the server address and API key in Settings.')
    }
    const url = `${baseUrl.replace(/\/$/, '')}/api/v1${endpoint}`
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(customHeaders || {})
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new ApiError(`API error ${response.status}: ${text || response.statusText}`, response.status)
      }
      const contentType = (response.headers.get('content-type') || '').toLowerCase()
      if (contentType.includes('application/json')) return (await response.json()) as T
      return (await response.text()) as unknown as T
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new ApiError('Request timed out. Check your server address and network connection.')
      }
      if (e instanceof TypeError) {
        // fetch's only transport error; the message alone ("Failed to fetch")
        // gives the user nothing to act on.
        throw new ApiError(`Couldn't reach ${baseUrl}. Check the server address.`)
      }
      throw e
    } finally {
      clearTimeout(timeoutId)
    }
  }

  async getMe(): Promise<User> {
    return UserSchema.parse(await this.request<unknown>('/users/me'))
  }

  /**
   * The bookmark for a URL, or null. The server matches on a normalised URL
   * (hash fragment and trailing slash ignored), which is what "is this tab
   * saved?" means.
   */
  async checkUrl(url: string): Promise<string | null> {
    const data = await this.request<{ bookmarkId: string | null }>(
      `/bookmarks/check-url?url=${encodeURIComponent(url)}`
    )
    return data.bookmarkId ?? null
  }

  async getBookmark(id: string): Promise<Bookmark> {
    return BookmarkSchema.parse(await this.request<unknown>(`/bookmarks/${id}`))
  }

  /** Creates a link bookmark; an already-saved URL comes back as the existing one. */
  async createLinkBookmark(url: string, title?: string): Promise<Bookmark> {
    const res = await this.request<unknown>('/bookmarks', {
      method: 'POST',
      body: { type: 'link', url, ...(title ? { title } : {}), source: 'extension' }
    })
    return BookmarkSchema.parse(res)
  }

  async updateBookmark(id: string, data: UpdateBookmarkInput): Promise<Bookmark> {
    return BookmarkSchema.parse(await this.request<unknown>(`/bookmarks/${id}`, { method: 'PATCH', body: data }))
  }

  async deleteBookmark(id: string): Promise<void> {
    await this.request<unknown>(`/bookmarks/${id}`, { method: 'DELETE' })
  }

  async attachTags(bookmarkId: string, tagNames: string[]): Promise<void> {
    await this.request<unknown>(`/bookmarks/${bookmarkId}/tags`, {
      method: 'POST',
      body: { tags: tagNames.map((tagName) => ({ tagName })) }
    })
  }

  async detachTags(bookmarkId: string, tagNames: string[]): Promise<void> {
    await this.request<unknown>(`/bookmarks/${bookmarkId}/tags`, {
      method: 'DELETE',
      body: { tags: tagNames.map((tagName) => ({ tagName })) }
    })
  }

  async getTags(): Promise<KKTag[]> {
    return TagsResponseSchema.parse(await this.request<unknown>('/tags')).tags
  }

  async getLists(): Promise<KKList[]> {
    return ListsResponseSchema.parse(await this.request<unknown>('/lists')).lists
  }

  async getBookmarkLists(bookmarkId: string): Promise<KKList[]> {
    return ListsResponseSchema.parse(await this.request<unknown>(`/bookmarks/${bookmarkId}/lists`)).lists
  }

  async addToList(listId: string, bookmarkId: string): Promise<void> {
    await this.request<unknown>(`/lists/${listId}/bookmarks/${bookmarkId}`, { method: 'PUT' })
  }

  async removeFromList(listId: string, bookmarkId: string): Promise<void> {
    await this.request<unknown>(`/lists/${listId}/bookmarks/${bookmarkId}`, { method: 'DELETE' })
  }

  async getBookmarkHighlights(bookmarkId: string): Promise<Highlight[]> {
    return HighlightsResponseSchema.parse(await this.request<unknown>(`/bookmarks/${bookmarkId}/highlights`))
      .highlights
  }

  async createHighlight(data: {
    bookmarkId: string
    startOffset: number
    endOffset: number
    color?: string
    text: string
    note?: string
  }): Promise<Highlight> {
    // The server wants `note` present, not merely optional, and 400s on a
    // colour outside its enum — see the same call in src/main/api.ts.
    return (await this.request<unknown>('/highlights', {
      method: 'POST',
      body: { ...data, color: normalizeHighlightColor(data.color), note: data.note ?? '' }
    })) as Highlight
  }

  async updateHighlight(id: string, data: { color?: string; note?: string }): Promise<Highlight> {
    const body = data.color === undefined ? data : { ...data, color: normalizeHighlightColor(data.color) }
    return (await this.request<unknown>(`/highlights/${id}`, { method: 'PATCH', body })) as Highlight
  }

  async deleteHighlight(id: string): Promise<void> {
    await this.request<unknown>(`/highlights/${id}`, { method: 'DELETE' })
  }
}
