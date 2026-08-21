import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'
import type {
  AssetUploadInput,
  Bookmark,
  BookmarkListFilter,
  BookmarksPage,
  CreateBookmarkInput,
  CreateHighlightInput,
  CreateListInput,
  Highlight,
  KKList,
  KKTag,
  ListOrder,
  UpdateBookmarkInput,
  UpdateListInput,
  UpdateTagInput,
  UploadedAsset
} from '../../../shared/types'

export function useBookmarksList(
  enabled = true,
  filter: BookmarkListFilter = {}
): UseInfiniteQueryResult<{ pages: BookmarksPage[] }, Error> {
  return useInfiniteQuery({
    // The filter is part of the key: Favourites, Archive and All bookmarks
    // are three different server queries and must not share one cache.
    queryKey: ['bookmarks', 'list', filter],
    queryFn: ({ pageParam }) =>
      window.kk.bookmarks.list({ limit: 30, cursor: pageParam as string | undefined, ...filter }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: BookmarksPage) => lastPage.nextCursor || undefined,
    enabled
  })
}

export function useBookmarksSearch(q: string): UseInfiniteQueryResult<{ pages: BookmarksPage[] }, Error> {
  return useInfiniteQuery({
    queryKey: ['bookmarks', 'search', q],
    queryFn: ({ pageParam }) =>
      window.kk.bookmarks.search({ q, limit: 30, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: BookmarksPage) => lastPage.nextCursor || undefined,
    enabled: q.trim().length > 0
  })
}

export function useListBookmarks(
  listId: string,
  enabled: boolean
): UseInfiniteQueryResult<{ pages: BookmarksPage[] }, Error> {
  return useInfiniteQuery({
    queryKey: ['bookmarks', 'list-scoped', listId],
    queryFn: ({ pageParam }) =>
      window.kk.lists.getBookmarks(listId, { limit: 30, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: BookmarksPage) => lastPage.nextCursor || undefined,
    enabled
  })
}

export function useTagBookmarks(
  tagId: string,
  enabled: boolean
): UseInfiniteQueryResult<{ pages: BookmarksPage[] }, Error> {
  return useInfiniteQuery({
    queryKey: ['bookmarks', 'tag-scoped', tagId],
    queryFn: ({ pageParam }) =>
      window.kk.tags.getBookmarks(tagId, { limit: 30, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: BookmarksPage) => lastPage.nextCursor || undefined,
    enabled
  })
}

export function useLists(): UseQueryResult<KKList[], Error> {
  return useQuery({ queryKey: ['lists'], queryFn: () => window.kk.lists.get() })
}

/**
 * One bookmark, live. Deliberately keyed OUTSIDE the ['bookmarks'] prefix:
 * that prefix is reserved for the paginated feeds, and the bulk
 * setQueriesData helpers below assume every cache under it has a `pages`
 * array. Keeping this singular key separate means those helpers can stay
 * simple, at the cost of naming it explicitly in each mutation.
 */
export function useBookmark(id: string | undefined): UseQueryResult<Bookmark, Error> {
  return useQuery({
    queryKey: ['bookmark', id],
    queryFn: () => window.kk.bookmarks.get(id as string),
    enabled: !!id
  })
}

/**
 * The lists one bookmark belongs to. Kept separate from the ['lists'] tree:
 * that query answers "what lists exist", this one answers "where does this
 * bookmark live", and only the latter has to be re-fetched when a bookmark
 * is added to or removed from a list.
 */
export function useBookmarkLists(bookmarkId: string | undefined): UseQueryResult<KKList[], Error> {
  return useQuery({
    queryKey: ['bookmarkLists', bookmarkId],
    queryFn: () => window.kk.bookmarks.getLists(bookmarkId as string),
    enabled: !!bookmarkId
  })
}

export function useTags(): UseQueryResult<KKTag[], Error> {
  return useQuery({ queryKey: ['tags'], queryFn: () => window.kk.tags.get() })
}

/**
 * The global highlight stream, paginated.
 *
 * The sidebar's Highlights view filters by colour, but `GET /highlights`
 * accepts only `cursor` and `limit` — there is no colour parameter (see
 * main/api.ts). So the filter is applied client-side over whatever pages
 * have been pulled, and the view keeps pulling as the user scrolls. The
 * consequence is worth being honest about in the UI: a colour filter is
 * complete only for the highlights loaded so far, which is why
 * HighlightsList labels its count "of N loaded" rather than claiming a
 * library total.
 */
export function useAllHighlights(
  enabled = true
): UseInfiniteQueryResult<{ pages: { highlights: Highlight[]; nextCursor?: string | null }[] }, Error> {
  return useInfiniteQuery({
    queryKey: ['highlights', 'all'],
    queryFn: ({ pageParam }) => window.kk.highlights.get({ limit: 50, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: { nextCursor?: string | null }) => lastPage.nextCursor || undefined,
    enabled
  })
}

/**
 * Highlights for one bookmark, fetched per bookmark rather than filtered out
 * of the global feed — the feed is paginated, so filtering it drops every
 * highlight past the first page for anyone with a decent-sized library.
 */
export function useHighlightsForBookmark(bookmarkId: string | undefined): Highlight[] {
  const { data } = useQuery({
    queryKey: ['highlights', 'bookmark', bookmarkId],
    queryFn: () => window.kk.highlights.forBookmark(bookmarkId as string),
    enabled: !!bookmarkId
  })
  return data || []
}

export function flattenBookmarks(pages: BookmarksPage[] | undefined): Bookmark[] {
  if (!pages) return []
  return pages.flatMap((p) => p.bookmarks)
}

// ─────────────────────────── Local-only list order ───────────────────────────
// See shared/types.ts ListOrder — sibling order is never sent to the
// server, so this query/mutation pair talks to main/store.ts only.
export function useListOrder(): UseQueryResult<ListOrder, Error> {
  return useQuery({ queryKey: ['listOrder'], queryFn: () => window.kk.store.getListOrder() })
}

export function useSetListOrder(): UseMutationResult<void, Error, ListOrder> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (order: ListOrder) => window.kk.store.setListOrder(order),
    onMutate: async (order) => {
      await queryClient.cancelQueries({ queryKey: ['listOrder'] })
      const previous = queryClient.getQueryData<ListOrder>(['listOrder'])
      queryClient.setQueryData(['listOrder'], order)
      return { previous }
    },
    onError: (_err, _order, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['listOrder'], ctx.previous)
    }
  })
}

// ─────────────────────────── List mutations ───────────────────────────

export function useCreateList(): UseMutationResult<KKList, Error, CreateListInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateListInput) => window.kk.lists.create(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ['lists'] })
      const previous = queryClient.getQueryData<KKList[]>(['lists'])
      const optimistic: KKList = {
        id: `temp-${Date.now()}`,
        name: input.name,
        icon: input.icon,
        parentId: input.parentId ?? null
      }
      queryClient.setQueryData<KKList[]>(['lists'], (old) => [...(old || []), optimistic])
      return { previous }
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['lists'], ctx.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['lists'] })
    }
  })
}

export function useUpdateList(): UseMutationResult<KKList, Error, { id: string; input: UpdateListInput }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateListInput }) => window.kk.lists.update(id, input),
    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey: ['lists'] })
      const previous = queryClient.getQueryData<KKList[]>(['lists'])
      queryClient.setQueryData<KKList[]>(['lists'], (old) =>
        (old || []).map((l) => (l.id === id ? { ...l, ...input } : l))
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['lists'], ctx.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['lists'] })
    }
  })
}

export function useDeleteList(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.kk.lists.delete(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['lists'] })
      const previous = queryClient.getQueryData<KKList[]>(['lists'])
      // Verified against the live server: deleting a parent list does NOT
      // cascade — its direct children survive and are reparented to root
      // (parentId -> null). Grandchildren keep their own parent, so only
      // one level moves. Mirror that here so the sidebar doesn't flicker
      // the subtree out and back in before invalidate-on-settle lands.
      queryClient.setQueryData<KKList[]>(['lists'], (old) =>
        (old || [])
          .filter((l) => l.id !== id)
          .map((l) => ((l.parentId ?? null) === id ? { ...l, parentId: null } : l))
      )
      return { previous }
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['lists'], ctx.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['lists'] })
    }
  })
}

export function useAddBookmarkToList(): UseMutationResult<void, Error, { listId: string; bookmarkId: string }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ listId, bookmarkId }: { listId: string; bookmarkId: string }) =>
      window.kk.lists.addBookmark(listId, bookmarkId),
    onSettled: (_data, _err, { listId, bookmarkId }) => {
      void queryClient.invalidateQueries({ queryKey: ['bookmarks', 'list-scoped', listId] })
      void queryClient.invalidateQueries({ queryKey: ['bookmarks', 'list'] })
      void queryClient.invalidateQueries({ queryKey: ['bookmarkLists', bookmarkId] })
    }
  })
}

export function useRemoveBookmarkFromList(): UseMutationResult<void, Error, { listId: string; bookmarkId: string }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ listId, bookmarkId }: { listId: string; bookmarkId: string }) =>
      window.kk.lists.removeBookmark(listId, bookmarkId),
    onMutate: async ({ listId, bookmarkId }) => {
      // Drop the row from the list-scoped feed straight away. Without this,
      // "Remove from this list" leaves the bookmark sitting in the list it
      // was just removed from until the refetch lands, which reads as the
      // command having done nothing.
      await queryClient.cancelQueries({ queryKey: ['bookmarks', 'list-scoped', listId] })
      const previous = queryClient.getQueryData<BookmarkPages>(['bookmarks', 'list-scoped', listId])
      queryClient.setQueryData<BookmarkPages>(['bookmarks', 'list-scoped', listId], (old) =>
        withoutBookmark(old, bookmarkId)
      )
      return { previous }
    },
    onError: (_err, { listId }, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['bookmarks', 'list-scoped', listId], ctx.previous)
    },
    onSettled: (_data, _err, { listId, bookmarkId }) => {
      void queryClient.invalidateQueries({ queryKey: ['bookmarks', 'list-scoped', listId] })
      void queryClient.invalidateQueries({ queryKey: ['bookmarks', 'list'] })
      void queryClient.invalidateQueries({ queryKey: ['bookmarkLists', bookmarkId] })
    }
  })
}

// ─────────────────────────── Tag mutations ───────────────────────────

export function useUpdateTag(): UseMutationResult<KKTag, Error, { id: string; input: UpdateTagInput }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTagInput }) => window.kk.tags.update(id, input),
    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey: ['tags'] })
      const previous = queryClient.getQueryData<KKTag[]>(['tags'])
      queryClient.setQueryData<KKTag[]>(['tags'], (old) =>
        (old || []).map((t) => (t.id === id ? { ...t, ...input } : t))
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['tags'], ctx.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] })
    }
  })
}

export function useDeleteTag(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.kk.tags.delete(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['tags'] })
      const previous = queryClient.getQueryData<KKTag[]>(['tags'])
      queryClient.setQueryData<KKTag[]>(['tags'], (old) => (old || []).filter((t) => t.id !== id))
      return { previous }
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['tags'], ctx.previous)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] })
    }
  })
}

export function useAttachTags(): UseMutationResult<void, Error, { bookmarkId: string; tagNames: string[] }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ bookmarkId, tagNames }: { bookmarkId: string; tagNames: string[] }) =>
      window.kk.tags.attach(bookmarkId, tagNames),
    onSettled: (_data, _err, { bookmarkId }) => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] })
      void queryClient.invalidateQueries({ queryKey: ['bookmarks'] })
      void queryClient.invalidateQueries({ queryKey: ['bookmark', bookmarkId] })
    }
  })
}

export function useDetachTags(): UseMutationResult<void, Error, { bookmarkId: string; tagNames: string[] }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ bookmarkId, tagNames }: { bookmarkId: string; tagNames: string[] }) =>
      window.kk.tags.detach(bookmarkId, tagNames),
    onMutate: async ({ bookmarkId, tagNames }) => {
      // The chip must vanish on click. Without this the tag sits there for
      // the length of a DELETE plus a refetch, which is long enough for a
      // second click to fire a redundant detach for a tag already gone.
      await queryClient.cancelQueries({ queryKey: ['bookmark', bookmarkId] })
      const previous = queryClient.getQueryData<Bookmark>(['bookmark', bookmarkId])
      const removing = new Set(tagNames)
      queryClient.setQueryData<Bookmark>(['bookmark', bookmarkId], (old) =>
        old ? { ...old, tags: (old.tags || []).filter((t) => !removing.has(t.name)) } : old
      )
      return { previous }
    },
    onError: (_err, { bookmarkId }, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['bookmark', bookmarkId], ctx.previous)
    },
    onSettled: (_data, _err, { bookmarkId }) => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] })
      void queryClient.invalidateQueries({ queryKey: ['bookmarks'] })
      void queryClient.invalidateQueries({ queryKey: ['bookmark', bookmarkId] })
    }
  })
}

// ─────────────────────────── Bookmark mutations ───────────────────────────
// Every bookmark feed — all / favourites / archive / per-list / per-tag /
// search — is a separate infinite cache under the ['bookmarks'] prefix, and
// the same bookmark can be sitting in several of them at once. Starring a
// row in a list view has to light up the star in every other view that
// happens to be cached, so these helpers edit *all* matching caches rather
// than the one the mutation was fired from.

/** Shape react-query stores an infinite bookmark query in. */
type BookmarkPages = { pages: BookmarksPage[]; pageParams: unknown[] }

function withPatchedBookmark(
  data: BookmarkPages | undefined,
  id: string,
  patch: UpdateBookmarkInput
): BookmarkPages | undefined {
  if (!data) return data
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      bookmarks: page.bookmarks.map((b) => (b.id === id ? { ...b, ...patch } : b))
    }))
  }
}

function withoutBookmark(data: BookmarkPages | undefined, id: string): BookmarkPages | undefined {
  if (!data) return data
  return {
    ...data,
    pages: data.pages.map((page) => ({ ...page, bookmarks: page.bookmarks.filter((b) => b.id !== id) }))
  }
}

/**
 * Snapshot of every cached bookmark feed, for rollback. Returned as the
 * mutation context so onError can put things back exactly as they were —
 * restoring only the feed the click came from would leave the optimistic
 * edit stranded in all the others.
 */
type BookmarkSnapshot = [readonly unknown[], BookmarkPages | undefined][]

function snapshotBookmarkFeeds(queryClient: ReturnType<typeof useQueryClient>): BookmarkSnapshot {
  return queryClient.getQueriesData<BookmarkPages>({ queryKey: ['bookmarks'] })
}

function restoreBookmarkFeeds(
  queryClient: ReturnType<typeof useQueryClient>,
  snapshot: BookmarkSnapshot | undefined
): void {
  for (const [key, data] of snapshot || []) queryClient.setQueryData(key, data)
}

export function useCreateBookmark(): UseMutationResult<Bookmark, Error, CreateBookmarkInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateBookmarkInput) => window.kk.bookmarks.create(input),
    // No optimistic entry here: the "all bookmarks" feed is an infinite,
    // cursor-paginated cache — splicing a fabricated row into page 1 in a
    // way that survives refetch/scroll correctly isn't cheap-and-correct
    // per the mutation guideline, so this just invalidates on success.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bookmarks'] })
    }
  })
}

/**
 * Title / note / summary / archived / favourited, all through the one PATCH.
 *
 * The optimistic patch deliberately does NOT drop a row that no longer
 * matches the feed it's in (an archived bookmark in the "All bookmarks"
 * feed, say). Yanking the row out from under the pointer the instant the
 * star is clicked makes the list jump and loses the selection; leaving it
 * in place until the invalidate-on-settle refetch arrives lets the user see
 * the state change on the row they clicked, then settle.
 */
export function useUpdateBookmark(): UseMutationResult<
  Bookmark,
  Error,
  { id: string; input: UpdateBookmarkInput }
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateBookmarkInput }) =>
      window.kk.bookmarks.update(id, input),
    onMutate: async ({ id, input }) => {
      await queryClient.cancelQueries({ queryKey: ['bookmarks'] })
      await queryClient.cancelQueries({ queryKey: ['bookmark', id] })
      const previous = snapshotBookmarkFeeds(queryClient)
      const previousOne = queryClient.getQueryData<Bookmark>(['bookmark', id])
      queryClient.setQueriesData<BookmarkPages>({ queryKey: ['bookmarks'] }, (old) =>
        withPatchedBookmark(old, id, input)
      )
      queryClient.setQueryData<Bookmark>(['bookmark', id], (old) => (old ? { ...old, ...input } : old))
      return { previous, previousOne }
    },
    onError: (_err, { id }, ctx) => {
      restoreBookmarkFeeds(queryClient, ctx?.previous)
      if (ctx?.previousOne) queryClient.setQueryData(['bookmark', id], ctx.previousOne)
    },
    onSettled: (_data, _err, { id }) => {
      void queryClient.invalidateQueries({ queryKey: ['bookmarks'] })
      void queryClient.invalidateQueries({ queryKey: ['bookmark', id] })
    }
  })
}

export function useDeleteBookmark(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => window.kk.bookmarks.delete(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['bookmarks'] })
      const previous = snapshotBookmarkFeeds(queryClient)
      queryClient.setQueriesData<BookmarkPages>({ queryKey: ['bookmarks'] }, (old) =>
        withoutBookmark(old, id)
      )
      return { previous }
    },
    onError: (_err, _id, ctx) => restoreBookmarkFeeds(queryClient, ctx?.previous),
    onSuccess: (_data, id) => {
      // Drop the single-bookmark cache outright rather than invalidating
      // it: a refetch of a bookmark that no longer exists is a guaranteed
      // 404, which would surface in the detail pane as an error where
      // "gone" is the correct and expected outcome.
      queryClient.removeQueries({ queryKey: ['bookmark', id] })
      queryClient.removeQueries({ queryKey: ['bookmarkLists', id] })
      queryClient.removeQueries({ queryKey: ['highlights', 'bookmark', id] })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['bookmarks'] })
      // A deleted bookmark takes its tag attachments with it, so the
      // sidebar's per-tag counts are now stale.
      void queryClient.invalidateQueries({ queryKey: ['tags'] })
    }
  })
}

/**
 * Uploads one file and returns the stored asset. Separate from
 * useCreateBookmark on purpose — the two are distinct server calls, and
 * keeping them apart lets the caller report "the upload failed" differently
 * from "the file uploaded but the bookmark wasn't created".
 */
export function useUploadAsset(): UseMutationResult<UploadedAsset, Error, AssetUploadInput> {
  return useMutation({ mutationFn: (input: AssetUploadInput) => window.kk.assets.upload(input) })
}

// ───────────────────────── Highlights ─────────────────────────
// Written from the renderer by the PDF pane. The Web pane's highlights are
// written by main, from the pane's preload events, and land back here through
// the WEBPANE_HIGHLIGHTS_CHANGED_EVENT push — either way the cache key that
// gets invalidated is the same one.

export function useCreateHighlight(): UseMutationResult<Highlight, Error, CreateHighlightInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateHighlightInput) => window.kk.highlights.create(input),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: ['highlights', 'bookmark', input.bookmarkId] })
      void queryClient.invalidateQueries({ queryKey: ['highlights', 'all'] })
    }
  })
}

export function useUpdateHighlight(): UseMutationResult<
  Highlight,
  Error,
  { id: string; input: { color?: string; note?: string }; bookmarkId: string }
> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: { color?: string; note?: string }; bookmarkId: string }) =>
      window.kk.highlights.update(id, input),
    onSuccess: (_data, { bookmarkId }) => {
      void queryClient.invalidateQueries({ queryKey: ['highlights', 'bookmark', bookmarkId] })
      void queryClient.invalidateQueries({ queryKey: ['highlights', 'all'] })
    }
  })
}

export function useDeleteHighlight(): UseMutationResult<void, Error, { id: string; bookmarkId: string }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string; bookmarkId: string }) => window.kk.highlights.delete(id),
    onSuccess: (_data, { bookmarkId }) => {
      void queryClient.invalidateQueries({ queryKey: ['highlights', 'bookmark', bookmarkId] })
      void queryClient.invalidateQueries({ queryKey: ['highlights', 'all'] })
    }
  })
}
