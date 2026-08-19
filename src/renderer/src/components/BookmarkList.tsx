import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useBookmarksList, useBookmarksSearch, flattenBookmarks } from '../lib/queries'
import type { Bookmark } from '../../../shared/types'
import AssetImage from './AssetImage'

type Selection = { type: 'all' } | { type: 'list'; id: string } | { type: 'tag'; id: string }

function faviconFallback(url?: string | null): string {
  try {
    if (!url) return ''
    const u = new URL(url)
    return `${u.protocol}//${u.host}/favicon.ico`
  } catch {
    return ''
  }
}

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

  const listQuery = useBookmarksList()
  const searchQuery = useBookmarksSearch(debouncedQuery)
  const active = isSearching ? searchQuery : listQuery

  const bookmarks = useMemo(() => {
    const all = flattenBookmarks(active.data?.pages)
    if (isSearching) return all
    if (selection.type === 'tag') {
      return all.filter((b) => b.tags?.some((t) => t.id === selection.id))
    }
    return all
  }, [active.data, isSearching, selection])

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
        {selection.type === 'list' && !isSearching && (
          <div className="border-b border-neutral-100 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-neutral-800 dark:bg-amber-950/30 dark:text-amber-400">
            Filtering by list isn&apos;t wired up yet (no documented list-membership field on
            bookmarks) — showing all bookmarks.
          </div>
        )}
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const b = bookmarks[vi.index]
            if (!b) return null
            const isSelected = b.id === selectedId
            const title = b.title || b.content?.title || b.content?.url || 'Untitled'
            const url = b.content?.url || ''
            return (
              <button
                key={b.id}
                data-testid="bookmark-row"
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
                  {b.content?.imageAssetId ? (
                    <AssetImage assetId={b.content.imageAssetId} className="h-full w-full object-cover" />
                  ) : b.content?.favicon ? (
                    <img src={b.content.favicon} className="h-full w-full object-contain p-1.5" alt="" />
                  ) : (
                    <img src={faviconFallback(url)} className="h-full w-full object-contain p-1.5" alt="" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {title}
                  </div>
                  <div className="truncate text-xs text-neutral-500">{url}</div>
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
