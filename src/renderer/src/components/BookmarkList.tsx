import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  useBookmarksList,
  useBookmarksSearch,
  useDeleteBookmark,
  useListBookmarks,
  useRemoveBookmarkFromList,
  useTagBookmarks,
  useUpdateBookmark,
  flattenBookmarks
} from '../lib/queries'
import type { Bookmark } from '../../../shared/types'
import { filterForSelection, isFeedSelection, type Selection } from '../lib/selection'
import { displayForBookmark } from '../lib/bookmarkDisplay'
import BookmarkThumb from './BookmarkThumb'
import ConfirmDialog from './ConfirmDialog'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { BOOKMARK_DRAG_MIME, currentBookmarkDrag, type BookmarkDragPayload } from '../lib/dragTypes'
import { errMessage } from '../lib/errors'

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

type MenuState = { x: number; y: number; bookmark: Bookmark } | null

export default function BookmarkList({
  selection,
  selectedId,
  onSelectBookmark,
  onBookmarkDeleted
}: {
  selection: Selection
  selectedId: string | null
  onSelectBookmark: (b: Bookmark) => void
  onBookmarkDeleted: (id: string) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounced(query, 350)
  const isSearching = debouncedQuery.trim().length > 0

  // Each of these hooks is always called (rules-of-hooks) but only the one
  // matching the current mode is "enabled" / actually fetches. Search takes
  // priority over the sidebar selection, matching most bookmark apps' UX.
  const feedFilter = useMemo(() => filterForSelection(selection), [selection])
  const feedQuery = useBookmarksList(!isSearching && isFeedSelection(selection), feedFilter)
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
        : feedQuery

  const bookmarks = useMemo(() => flattenBookmarks(active.data?.pages), [active.data])

  const updateBookmark = useUpdateBookmark()
  const deleteBookmark = useDeleteBookmark()
  const removeFromList = useRemoveBookmarkFromList()

  const [menu, setMenu] = useState<MenuState>(null)
  const [pendingDelete, setPendingDelete] = useState<Bookmark | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const toggleFavourite = useCallback(
    (b: Bookmark) => {
      setActionError(null)
      updateBookmark.mutate(
        { id: b.id, input: { favourited: !b.favourited } },
        { onError: (err) => setActionError(`Couldn't update the bookmark. ${errMessage(err)}`) }
      )
    },
    [updateBookmark]
  )

  const toggleArchived = useCallback(
    (b: Bookmark) => {
      setActionError(null)
      updateBookmark.mutate(
        { id: b.id, input: { archived: !b.archived } },
        { onError: (err) => setActionError(`Couldn't update the bookmark. ${errMessage(err)}`) }
      )
    },
    [updateBookmark]
  )

  function confirmDelete(): void {
    const target = pendingDelete
    setPendingDelete(null)
    if (!target) return
    setActionError(null)
    deleteBookmark.mutate(target.id, {
      // Only clear the detail pane once the server has actually accepted the
      // delete. Clearing it optimistically and then having the request fail
      // would leave the user staring at an empty pane for a bookmark that is
      // still very much there.
      onSuccess: () => onBookmarkDeleted(target.id),
      onError: (err) => setActionError(`Couldn't delete the bookmark. ${errMessage(err)}`)
    })
  }

  function removeFromCurrentList(b: Bookmark): void {
    if (selection.type !== 'list') return
    setActionError(null)
    removeFromList.mutate(
      { listId: selection.id, bookmarkId: b.id },
      { onError: (err) => setActionError(`Couldn't remove it from the list. ${errMessage(err)}`) }
    )
  }

  const menuItems = (b: Bookmark): ContextMenuItem[] => [
    { label: b.favourited ? 'Remove from favourites' : 'Add to favourites', onSelect: () => toggleFavourite(b) },
    { label: b.archived ? 'Unarchive' : 'Archive', onSelect: () => toggleArchived(b) },
    ...(selection.type === 'list'
      ? [{ label: 'Remove from this list', onSelect: () => removeFromCurrentList(b) }]
      : []),
    { label: 'Delete…', danger: true, onSelect: () => setPendingDelete(b) }
  ]

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

      {actionError && (
        <div className="flex items-start justify-between gap-2 border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="flex-shrink-0 font-medium hover:underline">
            Dismiss
          </button>
        </div>
      )}

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
                onContextMenu={(e) => {
                  e.preventDefault()
                  // Select as well as open the menu: acting on a row while
                  // the detail pane still shows a different bookmark is how
                  // people delete the wrong thing.
                  onSelectBookmark(b)
                  setMenu({ x: e.clientX, y: e.clientY, bookmark: b })
                }}
                onKeyDown={(e) => {
                  if (e.metaKey || e.ctrlKey || e.altKey) return
                  if (e.key === 'f' || e.key === 'F') {
                    e.preventDefault()
                    toggleFavourite(b)
                  } else if (e.key === 'e' || e.key === 'E') {
                    e.preventDefault()
                    toggleArchived(b)
                  } else if (e.key === 'Backspace' || e.key === 'Delete') {
                    e.preventDefault()
                    setPendingDelete(b)
                  }
                }}
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
                  <div className="flex items-baseline gap-1.5">
                    {b.favourited && (
                      <span
                        className="flex-shrink-0 text-xs leading-none text-amber-500"
                        title="Favourite"
                        aria-label="Favourite"
                      >
                        ★
                      </span>
                    )}
                    <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {display.title}
                    </span>
                    {/* Archived rows only reach a feed that isn't the
                        Archive view via search or a list/tag query, where
                        the badge is the only thing explaining why a
                        supposedly filed-away bookmark is on screen. */}
                    {b.archived && selection.type !== 'archived' && (
                      <span className="flex-shrink-0 rounded bg-neutral-200 px-1 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                        Archived
                      </span>
                    )}
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
          <div className="p-4 text-sm text-neutral-400">{emptyMessage(selection, isSearching)}</div>
        )}
        {active.isFetchingNextPage && <div className="p-3 text-center text-xs text-neutral-400">Loading more…</div>}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.bookmark)} onClose={() => setMenu(null)} />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${displayForBookmark(pendingDelete).title}"?`}
          description="This deletes the bookmark from Karakeep entirely, along with its tags, notes and highlights. It cannot be undone. To just get it out of the way, archive it instead."
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}


function emptyMessage(selection: Selection, isSearching: boolean): string {
  if (isSearching) return 'No bookmarks found.'
  if (selection.type === 'favourites') return 'No favourites yet. Star a bookmark to see it here.'
  if (selection.type === 'archived') return 'Nothing archived.'
  return 'No bookmarks found.'
}
