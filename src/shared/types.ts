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
}

export interface AuthResult {
  ok: boolean
  user?: User
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
