/**
 * Karakeep API client (main process only).
 * Ported from reference/karakeep-extension-api.js to TypeScript.
 * The API key never leaves the main process.
 */
import {
  BookmarksPageSchema,
  HighlightsResponseSchema,
  ListsResponseSchema,
  TagsResponseSchema,
  UserSchema,
  type BookmarksPage,
  type Highlight,
  type KKList,
  type KKTag,
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
    const res = await this.request<unknown>('/highlights', { method: 'POST', body: data })
    return res as Highlight
  }

  async updateHighlight(id: string, data: { color?: string; note?: string }): Promise<Highlight> {
    const res = await this.request<unknown>(`/highlights/${id}`, { method: 'PATCH', body: data })
    return res as Highlight
  }

  async deleteHighlight(id: string): Promise<void> {
    await this.request<unknown>(`/highlights/${id}`, { method: 'DELETE' })
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
}
