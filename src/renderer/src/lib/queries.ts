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
  Bookmark,
  BookmarksPage,
  CreateBookmarkInput,
  CreateHighlightInput,
  CreateListInput,
  Highlight,
  KKList,
  KKTag,
  ListOrder,
  UpdateListInput,
  UpdateTagInput
} from '../../../shared/types'

export function useBookmarksList(
  enabled = true
): UseInfiniteQueryResult<{ pages: BookmarksPage[] }, Error> {
  return useInfiniteQuery({
    queryKey: ['bookmarks', 'list'],
    queryFn: ({ pageParam }) => window.kk.bookmarks.list({ limit: 30, cursor: pageParam as string | undefined }),
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

export function useTags(): UseQueryResult<KKTag[], Error> {
  return useQuery({ queryKey: ['tags'], queryFn: () => window.kk.tags.get() })
}

export function useAllHighlights(): UseQueryResult<{ highlights: Highlight[]; nextCursor?: string | null }, Error> {
  return useQuery({
    queryKey: ['highlights', 'all'],
    queryFn: () => window.kk.highlights.get({ limit: 100 })
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
    onSettled: (_data, _err, { listId }) => {
      void queryClient.invalidateQueries({ queryKey: ['bookmarks', 'list-scoped', listId] })
      void queryClient.invalidateQueries({ queryKey: ['bookmarks', 'list'] })
    }
  })
}

export function useRemoveBookmarkFromList(): UseMutationResult<void, Error, { listId: string; bookmarkId: string }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ listId, bookmarkId }: { listId: string; bookmarkId: string }) =>
      window.kk.lists.removeBookmark(listId, bookmarkId),
    onSettled: (_data, _err, { listId }) => {
      void queryClient.invalidateQueries({ queryKey: ['bookmarks', 'list-scoped', listId] })
      void queryClient.invalidateQueries({ queryKey: ['bookmarks', 'list'] })
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
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] })
      void queryClient.invalidateQueries({ queryKey: ['bookmarks'] })
    }
  })
}

export function useDetachTags(): UseMutationResult<void, Error, { bookmarkId: string; tagNames: string[] }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ bookmarkId, tagNames }: { bookmarkId: string; tagNames: string[] }) =>
      window.kk.tags.detach(bookmarkId, tagNames),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] })
      void queryClient.invalidateQueries({ queryKey: ['bookmarks'] })
    }
  })
}

// ─────────────────────────── Bookmark creation ───────────────────────────

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
