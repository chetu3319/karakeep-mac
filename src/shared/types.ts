import { z } from 'zod'

// ─────────────────────────── Users ───────────────────────────
export const UserSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  localUser: z.boolean().optional()
})
export type User = z.infer<typeof UserSchema>

// ─────────────────────────── Bookmarks ───────────────────────────
export const BookmarkTagSchema = z.object({
  id: z.string(),
  name: z.string(),
  attachedBy: z.string().optional()
})

export const BookmarkAssetSchema = z.object({
  id: z.string(),
  assetType: z.string(),
  fileName: z.string().nullable().optional()
})

// content is a discriminated-ish shape; not all fields present for all types.
export const BookmarkContentSchema = z
  .object({
    type: z.string(),
    url: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    imageUrl: z.string().nullable().optional(),
    imageAssetId: z.string().nullable().optional(),
    screenshotAssetId: z.string().nullable().optional(),
    favicon: z.string().nullable().optional(),
    contentAssetId: z.string().nullable().optional(),
    readerViewStatus: z.string().nullable().optional(),
    readerViewScore: z.number().nullable().optional(),
    preferredPreview: z.string().nullable().optional(),
    crawledAt: z.string().nullable().optional(),
    crawlStatus: z.string().nullable().optional(),
    author: z.string().nullable().optional(),
    publisher: z.string().nullable().optional(),
    datePublished: z.string().nullable().optional(),
    dateModified: z.string().nullable().optional(),
    // text / asset content types
    text: z.string().nullable().optional(),
    htmlContent: z.string().nullable().optional(),
    sourceUrl: z.string().nullable().optional(),
    assetType: z.string().nullable().optional(),
    assetId: z.string().nullable().optional(),
    fileName: z.string().nullable().optional(),
    size: z.number().nullable().optional()
  })
  .passthrough()
export type BookmarkContent = z.infer<typeof BookmarkContentSchema>

export const BookmarkSchema = z
  .object({
    id: z.string(),
    firstCreatedAt: z.string().optional(),
    createdAt: z.string().optional(),
    modifiedAt: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    archived: z.boolean().optional(),
    favourited: z.boolean().optional(),
    taggingStatus: z.string().nullable().optional(),
    summarizationStatus: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    userId: z.string().optional(),
    tags: z.array(BookmarkTagSchema).default([]),
    content: BookmarkContentSchema.optional(),
    assets: z.array(BookmarkAssetSchema).default([])
  })
  .passthrough()
export type Bookmark = z.infer<typeof BookmarkSchema>

export const BookmarksPageSchema = z.object({
  bookmarks: z.array(BookmarkSchema),
  nextCursor: z.string().nullable().optional()
})
export type BookmarksPage = z.infer<typeof BookmarksPageSchema>

// ─────────────────────────── Lists ───────────────────────────
export const ListSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    parentId: z.string().nullable().optional(),
    type: z.string().optional(),
    query: z.string().nullable().optional(),
    public: z.boolean().optional(),
    hasCollaborators: z.boolean().optional(),
    userRole: z.string().nullable().optional()
  })
  .passthrough()
export type KKList = z.infer<typeof ListSchema>

export const ListsResponseSchema = z.object({ lists: z.array(ListSchema) })

// ─────────────────────────── Tags ───────────────────────────
export const TagSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    numBookmarks: z.number().optional(),
    numBookmarksByAttachedType: z.record(z.string(), z.number()).optional()
  })
  .passthrough()
export type KKTag = z.infer<typeof TagSchema>

export const TagsResponseSchema = z.object({ tags: z.array(TagSchema) })

// ─────────────────────────── Highlights ───────────────────────────
export const HighlightSchema = z
  .object({
    id: z.string(),
    bookmarkId: z.string(),
    startOffset: z.number(),
    endOffset: z.number(),
    color: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: z.string().optional()
  })
  .passthrough()
export type Highlight = z.infer<typeof HighlightSchema>

export const HighlightsResponseSchema = z.object({
  highlights: z.array(HighlightSchema),
  nextCursor: z.string().nullable().optional()
})

// ─────────────────────────── Mutation inputs ───────────────────────────
// Shapes for the write endpoints, verified against a live Karakeep instance
// on 2026-08-19 (scoped sandbox, all test objects cleaned up). See the
// comment block above the write methods in main/api.ts for the confirmed
// status codes and response bodies.
export type CreateBookmarkInput =
  | { type: 'link'; url: string; title?: string; note?: string; tags?: { tagName: string }[] }
  | { type: 'text'; text: string; title?: string; tags?: { tagName: string }[] }
  // `assetType` is a closed enum server-side: a POST with anything other than
  // 'image' or 'pdf' comes back 400 with a ZodError naming those two options.
  // The asset itself must already be uploaded (see UploadedAsset).
  | { type: 'asset'; assetType: AssetKind; assetId: string; fileName?: string; title?: string }

export type AssetKind = 'image' | 'pdf'

/**
 * Fields PATCH /bookmarks/{id} accepts. Every one is optional — the server
 * patches only what's sent and returns the whole updated bookmark.
 */
export interface UpdateBookmarkInput {
  archived?: boolean
  favourited?: boolean
  title?: string | null
  note?: string | null
  summary?: string | null
}

/**
 * Response of POST /api/v1/assets (multipart, field name `file`).
 * Note `contentType` is what the *server* sniffed from the bytes, not what
 * the client declared — uploading a PNG while claiming image/webp still
 * comes back as image/png. Derive the bookmark's assetType from this field
 * rather than from the local file's extension or MIME type.
 */
export interface UploadedAsset {
  assetId: string
  contentType: string
  size: number
  fileName?: string | null
}

/** A file handed to the uploader, already read into memory by the renderer. */
export interface AssetUploadInput {
  fileName: string
  mimeType: string
  data: ArrayBuffer
}

/**
 * Maps an uploaded asset's content type onto the `assetType` enum that
 * POST /bookmarks accepts. Returns null for anything Karakeep can store as
 * an asset but can't hang a bookmark off — the caller should surface that
 * as "this file type can't be bookmarked" rather than guessing a kind and
 * eating a 400.
 */
export function assetKindFor(contentType: string): AssetKind | null {
  const normalized = contentType.split(';')[0].trim().toLowerCase()
  if (normalized === 'application/pdf') return 'pdf'
  if (normalized.startsWith('image/')) return 'image'
  return null
}

export interface CreateListInput {
  name: string
  icon: string
  parentId?: string | null
}

export interface UpdateListInput {
  name?: string
  icon?: string
  parentId?: string | null
}

export interface CreateHighlightInput {
  bookmarkId: string
  startOffset: number
  endOffset: number
  color?: string
  text?: string
  note?: string
}

export interface UpdateTagInput {
  name: string
}

/**
 * Server-side filters on GET /bookmarks. Verified live: both are honoured,
 * and omitting `archived` returns archived and unarchived bookmarks mixed
 * together — which is why the "All bookmarks" view passes archived: false
 * explicitly rather than relying on the default.
 */
export interface BookmarkListFilter {
  archived?: boolean
  favourited?: boolean
}

// ─────────────────────────── Local-only list order ───────────────────────────
// Karakeep's /lists response has no order/rank field (verified via a
// read-only GET), so sibling ordering within a parent is persisted locally
// only, never sent to the server. Keyed by parent list id, or the literal
// string 'root' for top-level lists. Lists not present in a parent's array
// sort after the ordered ones, alphabetically.
export type ListOrder = Record<string, string[]>

// ─────────────────────────── App config ───────────────────────────
export interface AppConfig {
  baseUrl: string
  customHeaders?: Record<string, string>
  hasApiKey: boolean
  hasGeminiApiKey?: boolean
  geminiModel?: string
  /** True when the stored Gemini key is unencrypted on disk (safeStorage unavailable on this machine). See store.ts. */
  geminiKeyUnencrypted?: boolean
}

export interface AuthResult {
  ok: boolean
  user?: User
  error?: string
}

// ─────────────────────────── AI Assistant (Gemini) ───────────────────────────
// The three in-situ modes match the product spec (Explain / Dejargonify /
// Define) verbatim; `micro-formula` ("Math") is a fourth mode kept because it
// is genuinely useful for the arxiv/paper use case, even though the spec only
// names three. `micro-explain` used to *define* a term — it now explains a
// selection in the document's own argument, and the old defining behaviour
// moved to the new `micro-define`, so neither label lies about what it does.
export type AiMode =
  | 'micro-explain'
  | 'micro-dejargon'
  | 'micro-define'
  | 'micro-formula'
  | 'meso-page'
  | 'macro-chat'
  | 'custom'

export interface AiChatMessage {
  role: 'user' | 'model'
  text: string
}

/**
 * `docKind` drives the noun the prompt builder uses ("paper" / "article" /
 * "note") so the system prompt stops hardcoding "this paper" for a blog post
 * or a saved note. The rest of these are the "website/source info" the
 * product spec asks be injected alongside the selection: where preload/
 * webpane.ts can read them straight off the live DOM (location.href,
 * document.title, og:site_name / author meta tags), the PDF and detail
 * panes source them from the bookmark's own `content` fields.
 */
export interface AiStreamRequest {
  requestId: string
  mode: AiMode
  selectionText?: string
  surroundingContext?: string
  pageText?: string
  docTitle?: string
  prompt?: string
  history?: AiChatMessage[]
  sourceUrl?: string
  siteName?: string
  author?: string
  docKind?: 'pdf' | 'article' | 'note'
}

export interface AiStreamChunk {
  requestId: string
  delta: string
}

export interface AiStreamDone {
  requestId: string
  fullText: string
}

export interface AiStreamError {
  requestId: string
  error: string
}

export interface AiTestResult {
  ok: boolean
  model?: string
  error?: string
}

// ─────────────────────────── Web pane ───────────────────────────
export interface WebPaneState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string | null
}

export interface WebPaneBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PendingHighlight {
  clientId: string
  bookmarkId: string
  text: string
  color: string
  note?: string
  prefix?: string
  suffix?: string
  startOffset: number
  endOffset: number
}

