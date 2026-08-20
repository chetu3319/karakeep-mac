import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  useBookmarksList,
  useBookmarksSearch,
  useListBookmarks,
  useTagBookmarks,
  flattenBookmarks
} from '../lib/queries'
import type { Bookmark } from '../../../shared/types'
import { displayForBookmark } from '../lib/bookmarkDisplay'
import BookmarkThumb from './BookmarkThumb'
import { BOOKMARK_DRAG_MIME, currentBookmarkDrag, type BookmarkDragPayload } from '../lib/dragTypes'

type Selection = { type: 'all' } | { type: 'list'; id: string } | { type: 'tag'; id: string }

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

export default function BookmarkList({
  selection,
  selectedId,
  onSelectBookmark
}: {
  selection: Selection
  selectedId: string | null
  onSelectBookmark: (b: Bookmark) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounced(query, 350)
  const isSearching = debouncedQuery.trim().length > 0

  // Each of these hooks is always called (rules-of-hooks) but only the one
  // matching the current mode is "enabled" / actually fetches. Search takes
  // priority over the sidebar selection, matching most bookmark apps' UX.
  const allQuery = useBookmarksList(!isSearching && selection.type === 'all')
  const searchQuery = useBookmarksSearch(debouncedQuery)
  const listQuery = useListBookmarks(
    selection.type === 'list' ? selection.id : '__none__',
    !isSearching && selection.type === 'list'
  )
  const tagQuery = useTagBookmarks(
    selection.type === 'tag' ? selection.id : '__none__',
    !isSearching && selection.type === 'tag'
  )

  const active = isSearching
    ? searchQuery
    : selection.type === 'list'
      ? listQuery
      : selection.type === 'tag'
        ? tagQuery
        : allQuery

  const bookmarks = useMemo(() => flattenBookmarks(active.data?.pages), [active.data])

  useEffect(() => {
    if (window.kk.dev.isSmoke && selection.type === 'list' && !active.isLoading) {
      window.kk.dev.notifyListReady()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, active.isLoading])

  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: bookmarks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 84,
    overscan: 8
  })

  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    function onScroll(): void {
      if (!el) return
      if (
        el.scrollTop + el.clientHeight > el.scrollHeight - 300 &&
        active.hasNextPage &&
        !active.isFetchingNextPage
      ) {
        active.fetchNextPage()
      }
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [active])

  return (
    <div className="flex h-full flex-col border-x border-neutral-200 dark:border-neutral-800">
      <div className="border-b border-neutral-200 p-2 dark:border-neutral-800">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search bookmarks…"
          data-testid="search-input"
          className="w-full rounded-lg border border-neutral-300 bg-neutral-50 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>

      <div ref={parentRef} className="flex-1 overflow-y-auto" data-testid="bookmark-list">
        {active.isLoading && <div className="p-4 text-sm text-neutral-400">Loading…</div>}
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const b = bookmarks[vi.index]
            if (!b) return null
            const isSelected = b.id === selectedId
            const display = displayForBookmark(b)
            const dragPayload: BookmarkDragPayload = isSearching
              ? { bookmarkId: b.id, sourceType: 'search' }
              : selection.type === 'list'
                ? { bookmarkId: b.id, sourceType: 'list', sourceId: selection.id }
                : selection.type === 'tag'
                  ? { bookmarkId: b.id, sourceType: 'tag', sourceId: selection.id }
                  : { bookmarkId: b.id, sourceType: 'all' }
            return (
              <button
                key={b.id}
                data-testid="bookmark-row"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(BOOKMARK_DRAG_MIME, JSON.stringify(dragPayload))
                  e.dataTransfer.effectAllowed = 'copyMove'
                  currentBookmarkDrag.current = dragPayload
                }}
                onDragEnd={() => {
                  currentBookmarkDrag.current = null
                }}
                onClick={() => onSelectBookmark(b)}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: vi.size,
                  transform: `translateY(${vi.start}px)`
                }}
                className={`flex items-start gap-3 border-b border-neutral-100 px-3 py-3 text-left transition-colors dark:border-neutral-900 ${
                  isSelected ? 'bg-emerald-600/10' : 'hover:bg-neutral-50 dark:hover:bg-neutral-900/60'
                }`}
              >
                <div className="mt-0.5 h-10 w-10 flex-shrink-0 overflow-hidden rounded-md bg-neutral-100 dark:bg-neutral-800">
                  <BookmarkThumb bookmark={b} display={display} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {display.title}
                  </div>
                  <div className="truncate text-xs text-neutral-500">{display.subtitle}</div>
                  {b.tags && b.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {b.tags.slice(0, 3).map((t) => (
                        <span
                          key={t.id}
                          className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
                        >
                          #{t.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
        {!active.isLoading && bookmarks.length === 0 && (
          <div className="p-4 text-sm text-neutral-400">No bookmarks found.</div>
        )}
        {active.isFetchingNextPage && <div className="p-3 text-center text-xs text-neutral-400">Loading more…</div>}
      </div>
    </div>
  )
}
