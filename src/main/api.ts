/**
 * Karakeep API client (main process only).
 * Ported from reference/karakeep-extension-api.js to TypeScript.
 * The API key never leaves the main process.
 */
import { net } from 'electron'
import {
  BookmarkSchema,
  BookmarksPageSchema,
  HighlightsResponseSchema,
  ListSchema,
  ListsResponseSchema,
  TagSchema,
  TagsResponseSchema,
  UserSchema,
  type AssetUploadInput,
  type Bookmark,
  type BookmarkListFilter,
  type BookmarksPage,
  type CreateBookmarkInput,
  type CreateListInput,
  type Highlight,
  type KKList,
  type KKTag,
  type UpdateBookmarkInput,
  type UpdateListInput,
  type UpdateTagInput,
  type UploadedAsset,
  type User
} from '../shared/types'
import { normalizeHighlightColor } from '../shared/highlightUi'

const DEFAULT_TIMEOUT_MS = 15000
// Uploads carry whole files, so they get a longer leash than a JSON call —
// a 40MB PDF over a home connection will not finish inside 15 seconds.
const UPLOAD_TIMEOUT_MS = 120000

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
      // Use Electron's net.fetch (Chromium network stack) rather than Node's
      // global fetch (undici). Only net.fetch honours the system proxy and the
      // system/corporate certificate store — the same stack the browser uses —
      // so a config that authenticates in the browser also works here. undici
      // ignores both and fails with an opaque "fetch failed".
      const response = await net.fetch(url, {
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
      // Only transport failures are worth a console line. An ApiError here is
      // the server answering with a non-2xx — ordinary control flow the caller
      // already handles, and logging it would print the URL (with bookmark and
      // asset ids) on every routine 401/404.
      //
      // Chromium puts the real reason in `message` (`net::ERR_CERT_DATE_INVALID`,
      // `net::ERR_NAME_NOT_RESOLVED`, ...) rather than in `cause` the way undici
      // did, so the message alone is now the diagnosis.
      if (!(e instanceof ApiError)) {
        console.error('[api] request failed', {
          url,
          method: options.method || 'GET',
          message: e instanceof Error ? e.message : String(e)
        })
      }
      throw e
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Multipart sibling of `request`. Deliberately does NOT go through it: the
   * shared helper hard-codes `Content-Type: application/json`, and a
   * multipart POST needs fetch to generate its own boundary header, which it
   * only does when no Content-Type is supplied.
   */
  private async requestMultipart<T>(endpoint: string, form: FormData, timeout?: number): Promise<T> {
    const { baseUrl, apiKey, customHeaders } = this.config
    if (!baseUrl || !apiKey) {
      throw new ApiError('Karakeep is not configured. Please set the server address and API key.')
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout || UPLOAD_TIMEOUT_MS)
    try {
      const response = await net.fetch(`${baseUrl.replace(/\/$/, '')}/api/v1${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, ...(customHeaders || {}) },
        body: form,
        signal: controller.signal
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new ApiError(`API error ${response.status}: ${text || response.statusText}`, response.status)
      }
      return (await response.json()) as T
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new ApiError('Upload timed out. Check your server address and network connection.')
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

  async listBookmarks(
    params: { limit?: number; cursor?: string } & BookmarkListFilter = {}
  ): Promise<BookmarksPage> {
    const qs = new URLSearchParams()
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.cursor) qs.set('cursor', params.cursor)
    // Sent only when defined: `archived=false` and "no archived filter" are
    // genuinely different queries here, so an undefined flag must not
    // stringify into the URL as one or the other.
    if (params.archived !== undefined) qs.set('archived', String(params.archived))
    if (params.favourited !== undefined) qs.set('favourited', String(params.favourited))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    const data = await this.request<unknown>(`/bookmarks${suffix}`)
    return BookmarksPageSchema.parse(data)
  }

  /**
   * One bookmark, always fresh. The detail pane reads through this rather
   * than rendering the row object the list handed it: once the pane can
   * edit a bookmark, a snapshot taken at selection time goes stale the
   * first time anything is changed from anywhere else.
   */
  async getBookmark(id: string): Promise<Bookmark> {
    const data = await this.request<unknown>(`/bookmarks/${id}`)
    return BookmarkSchema.parse(data)
  }

  /** The lists a single bookmark belongs to — drives the detail pane's chips. */
  async getBookmarkLists(bookmarkId: string): Promise<KKList[]> {
    const data = await this.request<unknown>(`/bookmarks/${bookmarkId}/lists`)
    return ListsResponseSchema.parse(data).lists
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
    // Colour is normalized here rather than at each call site: both panes
    // reach the API through this client, so this is the one place every
    // highlight write passes through.
    const res = await this.request<unknown>('/highlights', {
      method: 'POST',
      body: { ...data, color: normalizeHighlightColor(data.color), note: data.note ?? '' }
    })
    return res as Highlight
  }

  async updateHighlight(id: string, data: { color?: string; note?: string }): Promise<Highlight> {
    // A PATCH omitting `color` must stay a note-only edit, so only normalize
    // when a colour is actually being set.
    const body = data.color === undefined ? data : { ...data, color: normalizeHighlightColor(data.color) }
    const res = await this.request<unknown>(`/highlights/${id}`, { method: 'PATCH', body })
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
  //
  // Re-probed 2026-08-20 for the bookmark-level writes, same method
  // (throwaway bookmarks, deleted afterwards):
  // - PATCH /bookmarks/{id} 200 -> the whole updated bookmark. Accepts any
  //   subset of { archived, favourited, title, note, summary }; a follow-up
  //   GET confirms each field actually persisted.
  // - DELETE /bookmarks/{id} 204 (empty body); a follow-up GET 404s.
  // - POST /assets (multipart, field `file`) 200 ->
  //   { assetId, contentType, size, fileName }. The server sniffs the bytes
  //   and reports its own contentType, ignoring the declared one, and 400s
  //   ({"error":"Unsupported asset type"}) on anything that isn't an image
  //   or a PDF.
  // - POST /bookmarks with { type: 'asset', assetType, assetId, fileName }
  //   201. `assetType` is a closed enum of 'image' | 'pdf' — anything else
  //   400s with a ZodError listing those two.
  // - GET /bookmarks/{id}/lists 200 -> { lists: [...] }, same list shape as
  //   GET /lists.
  // - GET /bookmarks?archived=&favourited= both filter server-side. Omitting
  //   `archived` returns archived and unarchived rows mixed together.

  async createBookmark(data: CreateBookmarkInput): Promise<Bookmark> {
    const res = await this.request<unknown>('/bookmarks', { method: 'POST', body: data })
    return BookmarkSchema.parse(res)
  }

  async updateBookmark(id: string, data: UpdateBookmarkInput): Promise<Bookmark> {
    const res = await this.request<unknown>(`/bookmarks/${id}`, { method: 'PATCH', body: data })
    return BookmarkSchema.parse(res)
  }

  async deleteBookmark(id: string): Promise<void> {
    await this.request<unknown>(`/bookmarks/${id}`, { method: 'DELETE' })
  }

  /**
   * Uploads one file and returns the stored asset. Creating a bookmark from
   * a file is two steps: upload here, then POST /bookmarks with
   * { type: 'asset', assetId, assetType }. `assetKindFor` maps the server's
   * sniffed contentType onto the assetType enum that step needs.
   */
  async uploadAsset(input: AssetUploadInput): Promise<UploadedAsset> {
    const form = new FormData()
    form.append('file', new Blob([input.data], { type: input.mimeType }), input.fileName)
    return await this.requestMultipart<UploadedAsset>('/assets', form)
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
    const response = await net.fetch(url, {
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
    const response = await net.fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, ...(customHeaders || {}) }
    })
    if (!response.ok) throw new ApiError(`Asset error ${response.status}`, response.status)
    return await response.arrayBuffer()
  }
}
