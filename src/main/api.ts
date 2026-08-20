/**
 * Karakeep API client (main process only).
 * Ported from reference/karakeep-extension-api.js to TypeScript.
 * The API key never leaves the main process.
 */
import {
  BookmarkSchema,
  BookmarksPageSchema,
  HighlightsResponseSchema,
  ListSchema,
  ListsResponseSchema,
  TagSchema,
  TagsResponseSchema,
  UserSchema,
  type Bookmark,
  type BookmarksPage,
  type CreateBookmarkInput,
  type CreateListInput,
  type Highlight,
  type KKList,
  type KKTag,
  type UpdateListInput,
  type UpdateTagInput,
  type User
} from '../shared/types'

const DEFAULT_TIMEOUT_MS = 15000

export interface ApiClientConfig {
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

export class KarakeepApiClient {
  constructor(private config: ApiClientConfig) {}

  updateConfig(config: ApiClientConfig): void {
    this.config = config
  }

  private async request<T>(
    endpoint: string,
    options: { method?: string; body?: unknown; timeout?: number } = {}
  ): Promise<T> {
    const { baseUrl, apiKey, customHeaders } = this.config
    if (!baseUrl || !apiKey) {
      throw new ApiError('Karakeep is not configured. Please set the server address and API key.')
    }

    const url = `${baseUrl.replace(/\/$/, '')}/api/v1${endpoint}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(customHeaders || {})
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || DEFAULT_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new ApiError(`API error ${response.status}: ${text || response.statusText}`, response.status)
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase()
      if (contentType.includes('application/json')) {
        return (await response.json()) as T
      }
      return (await response.text()) as unknown as T
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new ApiError('Request timed out. Check your server address and network connection.')
      }
      throw e
    } finally {
      clearTimeout(timeoutId)
    }
  }

  async getMe(): Promise<User> {
    const data = await this.request<unknown>('/users/me')
    return UserSchema.parse(data)
  }

  async listBookmarks(params: { limit?: number; cursor?: string } = {}): Promise<BookmarksPage> {
    const qs = new URLSearchParams()
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.cursor) qs.set('cursor', params.cursor)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    const data = await this.request<unknown>(`/bookmarks${suffix}`)
    return BookmarksPageSchema.parse(data)
  }

  async searchBookmarks(params: { q: string; limit?: number; cursor?: string }): Promise<BookmarksPage> {
    const qs = new URLSearchParams()
    qs.set('q', params.q)
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.cursor) qs.set('cursor', params.cursor)
    const data = await this.request<unknown>(`/bookmarks/search?${qs.toString()}`)
    return BookmarksPageSchema.parse(data)
  }

  async getListBookmarks(listId: string, params: { limit?: number; cursor?: string } = {}): Promise<BookmarksPage> {
    const qs = new URLSearchParams()
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.cursor) qs.set('cursor', params.cursor)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    const data = await this.request<unknown>(`/lists/${listId}/bookmarks${suffix}`)
    return BookmarksPageSchema.parse(data)
  }

  async getTagBookmarks(tagId: string, params: { limit?: number; cursor?: string } = {}): Promise<BookmarksPage> {
    const qs = new URLSearchParams()
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.cursor) qs.set('cursor', params.cursor)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    const data = await this.request<unknown>(`/tags/${tagId}/bookmarks${suffix}`)
    return BookmarksPageSchema.parse(data)
  }

  async getLists(): Promise<KKList[]> {
    const data = await this.request<unknown>('/lists')
    return ListsResponseSchema.parse(data).lists
  }

  async getTags(): Promise<KKTag[]> {
    const data = await this.request<unknown>('/tags')
    return TagsResponseSchema.parse(data).tags
  }

  async getHighlights(params: { cursor?: string; limit?: number } = {}): Promise<{
    highlights: Highlight[]
    nextCursor?: string | null
  }> {
    const qs = new URLSearchParams()
    if (params.cursor) qs.set('cursor', params.cursor)
    if (params.limit) qs.set('limit', String(params.limit))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    const data = await this.request<unknown>(`/highlights${suffix}`)
    return HighlightsResponseSchema.parse(data)
  }

  /**
   * Highlights for one bookmark. Preferred over filtering the paginated
   * global /highlights feed client-side: that feed is capped per page, so a
   * library with more highlights than the page size silently loses the ones
   * that fall past the cap.
   */
  async getBookmarkHighlights(bookmarkId: string): Promise<Highlight[]> {
    const data = await this.request<unknown>(`/bookmarks/${bookmarkId}/highlights`)
    return HighlightsResponseSchema.parse(data).highlights
  }

  async createHighlight(data: {
    bookmarkId: string
    startOffset: number
    endOffset: number
    color?: string
    text?: string
    note?: string
  }): Promise<Highlight> {
    // The server's schema wants `note` present, not merely optional — a
    // POST without it comes back 400 with a ZodError on that field.
    const res = await this.request<unknown>('/highlights', {
      method: 'POST',
      body: { ...data, note: data.note ?? '' }
    })
    return res as Highlight
  }

  async updateHighlight(id: string, data: { color?: string; note?: string }): Promise<Highlight> {
    const res = await this.request<unknown>(`/highlights/${id}`, { method: 'PATCH', body: data })
    return res as Highlight
  }

  async deleteHighlight(id: string): Promise<void> {
    await this.request<unknown>(`/highlights/${id}`, { method: 'DELETE' })
  }

  // ───────────────────────── Writes ─────────────────────────
  // Every request/response shape below was verified against a live Karakeep
  // instance on 2026-08-19 under a scoped sign-off, using a throwaway
  // sandbox list and self-created test objects (all cleaned up afterwards).
  // Confirmed status codes: POST /lists 201, PATCH /lists 200, DELETE /lists
  // 204, PUT+DELETE /lists/{id}/bookmarks/{id} 204 (empty body), POST
  // /bookmarks 201, POST /bookmarks/{id}/tags 200 -> { attached: string[] },
  // DELETE /bookmarks/{id}/tags 200 -> { detached: string[] }, PATCH /tags
  // 200 -> { id, name } (note: no numBookmarks on the write response, which
  // is why TagSchema keeps that field optional), DELETE /tags 204.

  async createBookmark(data: CreateBookmarkInput): Promise<Bookmark> {
    const res = await this.request<unknown>('/bookmarks', { method: 'POST', body: data })
    return BookmarkSchema.parse(res)
  }

  async createList(data: CreateListInput): Promise<KKList> {
    const res = await this.request<unknown>('/lists', { method: 'POST', body: data })
    return ListSchema.parse(res)
  }

  async updateList(id: string, data: UpdateListInput): Promise<KKList> {
    const res = await this.request<unknown>(`/lists/${id}`, { method: 'PATCH', body: data })
    return ListSchema.parse(res)
  }

  async deleteList(id: string): Promise<void> {
    await this.request<unknown>(`/lists/${id}`, { method: 'DELETE' })
  }

  async addBookmarkToList(listId: string, bookmarkId: string): Promise<void> {
    await this.request<unknown>(`/lists/${listId}/bookmarks/${bookmarkId}`, { method: 'PUT' })
  }

  async removeBookmarkFromList(listId: string, bookmarkId: string): Promise<void> {
    await this.request<unknown>(`/lists/${listId}/bookmarks/${bookmarkId}`, { method: 'DELETE' })
  }

  async updateTag(id: string, data: UpdateTagInput): Promise<KKTag> {
    const res = await this.request<unknown>(`/tags/${id}`, { method: 'PATCH', body: data })
    return TagSchema.parse(res)
  }

  async deleteTag(id: string): Promise<void> {
    await this.request<unknown>(`/tags/${id}`, { method: 'DELETE' })
  }

  /**
   * Attaches tags to a bookmark by name. Karakeep has no standalone
   * create-tag endpoint — a tag is brought into existence by attaching it,
   * so this doubles as "create tag" from the UI's perspective.
   */
  async attachTagsToBookmark(bookmarkId: string, tagNames: string[]): Promise<void> {
    await this.request<unknown>(`/bookmarks/${bookmarkId}/tags`, {
      method: 'POST',
      body: { tags: tagNames.map((tagName) => ({ tagName })) }
    })
  }

  /**
   * Mirrors the attach shape ({ tags: [{ tagName }] }). Verified live: the
   * API accepts it, returns { detached: [tagId] }, and a follow-up GET of
   * the bookmark confirms the tag is actually gone from its `tags` array.
   */
  async detachTagsFromBookmark(bookmarkId: string, tagNames: string[]): Promise<void> {
    await this.request<unknown>(`/bookmarks/${bookmarkId}/tags`, {
      method: 'DELETE',
      body: { tags: tagNames.map((tagName) => ({ tagName })) }
    })
  }

  /** Fetch a raw asset (image, screenshot, etc.) and return it as a data URL. */
  async getAssetDataUrl(assetId: string): Promise<string> {
    const { baseUrl, apiKey, customHeaders } = this.config
    if (!baseUrl || !apiKey) throw new ApiError('Not configured')
    const url = `${baseUrl.replace(/\/$/, '')}/api/assets/${assetId}`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, ...(customHeaders || {}) }
    })
    if (!response.ok) throw new ApiError(`Asset error ${response.status}`, response.status)
    const contentType = response.headers.get('content-type') || 'application/octet-stream'
    const buf = Buffer.from(await response.arrayBuffer())
    return `data:${contentType};base64,${buf.toString('base64')}`
  }

  /**
   * Fetch a raw asset as bytes. Used for PDFs, where the base64 data URL of
   * `getAssetDataUrl` would inflate a multi-megabyte book by a third and then
   * hand the renderer a string it has to decode again. An ArrayBuffer rides
   * the structured clone straight through.
   */
  async getAssetBytes(assetId: string): Promise<ArrayBuffer> {
    const { baseUrl, apiKey, customHeaders } = this.config
    if (!baseUrl || !apiKey) throw new ApiError('Not configured')
    const url = `${baseUrl.replace(/\/$/, '')}/api/assets/${assetId}`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, ...(customHeaders || {}) }
    })
    if (!response.ok) throw new ApiError(`Asset error ${response.status}`, response.status)
    return await response.arrayBuffer()
  }
}
