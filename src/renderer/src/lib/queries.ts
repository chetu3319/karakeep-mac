import { useInfiniteQuery, useQuery, type UseInfiniteQueryResult, type UseQueryResult } from '@tanstack/react-query'
import type { Bookmark, BookmarksPage, Highlight, KKList, KKTag } from '../../../shared/types'

export function useBookmarksList(): UseInfiniteQueryResult<{ pages: BookmarksPage[] }, Error> {
  return useInfiniteQuery({
    queryKey: ['bookmarks', 'list'],
    queryFn: ({ pageParam }) => window.kk.bookmarks.list({ limit: 30, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: BookmarksPage) => lastPage.nextCursor || undefined
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

export function useHighlightsForBookmark(bookmarkId: string | undefined): Highlight[] {
  const { data } = useAllHighlights()
  const all = data?.highlights || []
  if (!bookmarkId) return []
  return all.filter((h) => h.bookmarkId === bookmarkId)
}

export function flattenBookmarks(pages: BookmarksPage[] | undefined): Bookmark[] {
  if (!pages) return []
  return pages.flatMap((p) => p.bookmarks)
}
