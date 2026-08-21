import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  useBookmarksList,
  useBookmarksSearch,
  useDeleteBookmark,
  useListBookmarks,
  useLists,
  useRemoveBookmarkFromList,
  useTagBookmarks,
  useTags,
  useUpdateBookmark,
  flattenBookmarks
} from '../lib/queries'
import type { Bookmark } from '../../../shared/types'
import { filterForSelection, isFeedSelection, selectionLabel, type Selection } from '../lib/selection'
import { displayForBookmark } from '../lib/bookmarkDisplay'
import { usePref } from '../lib/prefs'
import BookmarkThumb from './BookmarkThumb'
import ConfirmDialog from './ConfirmDialog'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Icon from './Icon'
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
type Density = 'comfortable' | 'compact'

const ROW_HEIGHT: Record<Density, number> = { comfortable: 84, compact: 44 }

export default function BookmarkList({
  selection,
  selectedId,
  onSelectBookmark,
  onBookmarkDeleted,
  onCollapse
}: {
  selection: Selection
  selectedId: string | null
  onSelectBookmark: (b: Bookmark) => void
  onBookmarkDeleted: (id: string) => void
  onCollapse: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounced(query, 350)
  const isSearching = debouncedQuery.trim().length > 0
  const [density, setDensity] = usePref<Density>('listDensity', 'comfortable')

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

  // Names for the scope chip and header. Both queries are already in cache
  // for the sidebar, so this costs nothing.
  const lists = useLists().data
  const tags = useTags().data
  const scopeName = useCallback(
    (sel: Selection): string | undefined => {
      if (sel.type === 'list') return lists?.find((l) => l.id === sel.id)?.name
      if (sel.type === 'tag') return tags?.find((t) => t.id === sel.id)?.name
      return undefined
    },
    [lists, tags]
  )
  const scopeLabel = selectionLabel(selection, scopeName)

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
  const searchRef = useRef<HTMLInputElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: bookmarks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT[density],
    // Rows were pinned to a flat 84px, so a row whose tag chips wrapped to
    // a second line had its bottom sliced off. Measuring means the
    // estimate only has to be close, and it lets one virtualizer serve
    // both densities.
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 8
  })

  // Switching density changes every row's height at once; without this the
  // virtualizer keeps handing out the old offsets until each row remeasures
  // on scroll, which leaves visible gaps between rows.
  useEffect(() => {
    rowVirtualizer.measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [density])

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

  // ⌘F from the Edit menu. Selecting the existing text means a second ⌘F
  // starts a new search rather than appending to the old one.
  useEffect(() => {
    return window.kk.window.onFocusSearch(() => {
      searchRef.current?.focus()
      searchRef.current?.select()
    })
  }, [])

  /**
   * Arrow-key navigation over the list.
   *
   * Rows are focusable buttons, so ↑/↓ used to do nothing but move DOM
   * focus without changing what the detail pane showed — and the `f`/`e`/
   * `⌫` shortcuts only fired when a row happened to hold focus, which for
   * a list you navigate by clicking is almost never. Handling this on the
   * container instead means the keys act on the *selected* bookmark, which
   * is the one the user can see.
   */
  const selectedIndex = useMemo(
    () => bookmarks.findIndex((b) => b.id === selectedId),
    [bookmarks, selectedId]
  )

  const step = useCallback(
    (delta: number) => {
      if (bookmarks.length === 0) return
      const next = selectedIndex === -1 ? (delta > 0 ? 0 : bookmarks.length - 1) : selectedIndex + delta
      if (next < 0 || next >= bookmarks.length) return
      onSelectBookmark(bookmarks[next])
      rowVirtualizer.scrollToIndex(next, { align: 'auto' })
      // Near the end, pull the next page so holding ↓ doesn't dead-end at
      // the pagination boundary.
      if (next > bookmarks.length - 5 && active.hasNextPage && !active.isFetchingNextPage) {
        void active.fetchNextPage()
      }
    },
    [bookmarks, selectedIndex, onSelectBookmark, rowVirtualizer, active]
  )

  function onListKeyDown(e: React.KeyboardEvent): void {
    // Never steal keys from the search box or an inline editor.
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    if (e.metaKey || e.ctrlKey || e.altKey) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      step(1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      step(-1)
      return
    }

    const current = selectedIndex >= 0 ? bookmarks[selectedIndex] : null
    if (!current) return
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault()
      toggleFavourite(current)
    } else if (e.key === 'e' || e.key === 'E') {
      e.preventDefault()
      toggleArchived(current)
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      setPendingDelete(current)
    }
  }

  const searchEscapedScope = isSearching && selection.type !== 'all'

  return (
    <div
      className="flex h-full flex-col border-r border-neutral-200 dark:border-neutral-800"
      onKeyDown={onListKeyDown}
    >
      <div className="flex-shrink-0 border-b border-neutral-200 px-2 py-2 dark:border-neutral-800">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Icon
              name="search"
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400"
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.stopPropagation()
                  setQuery('')
                }
              }}
              placeholder="Search bookmarks…"
              aria-label="Search bookmarks"
              data-testid="search-input"
              className="w-full rounded-lg border border-neutral-300 bg-neutral-50 py-1.5 pl-8 pr-7 text-sm outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-900"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => setDensity(density === 'comfortable' ? 'compact' : 'comfortable')}
            title={density === 'comfortable' ? 'Compact rows' : 'Comfortable rows'}
            aria-label={density === 'comfortable' ? 'Switch to compact rows' : 'Switch to comfortable rows'}
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <Icon name={density === 'comfortable' ? 'rows' : 'list'} size={15} />
          </button>
          {/* Collocated with the pane it hides, rather than in a distant
              corner of the window chrome. */}
          <button
            type="button"
            onClick={onCollapse}
            title="Hide bookmark list (⌃⌘L)"
            aria-label="Hide bookmark list"
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <Icon name="chevron-left" />
          </button>
        </div>

        {/*
          Search is server-side and global — it does not respect the
          selected list or tag. That used to happen silently while the
          sidebar still showed the list highlighted, so results from
          everywhere looked like results from that list.
        */}
        <div className="mt-1.5 flex items-center gap-1.5 px-0.5 text-xs">
          {searchEscapedScope ? (
            <>
              <span className="text-neutral-500">Searching all bookmarks</span>
              <button
                onClick={() => setQuery('')}
                className="rounded px-1 font-medium text-emerald-600 hover:bg-emerald-600/10 dark:text-emerald-400"
              >
                Back to {scopeLabel}
              </button>
            </>
          ) : (
            <>
              <span className="truncate text-neutral-500">{isSearching ? 'Search results' : scopeLabel}</span>
              {!active.isLoading && (
                <span className="tabular-nums text-neutral-400">
                  {bookmarks.length}
                  {active.hasNextPage ? '+' : ''}
                </span>
              )}
            </>
          )}
        </div>
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
        {active.isLoading && (
          <div className="space-y-3 p-3" aria-hidden>
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <div className="h-10 w-10 flex-shrink-0 animate-pulse rounded-md bg-neutral-200/70 dark:bg-neutral-800" />
                <div className="flex-1 space-y-2 py-0.5">
                  <div className="h-3 animate-pulse rounded bg-neutral-200/70 dark:bg-neutral-800" />
                  <div className="h-2.5 w-1/2 animate-pulse rounded bg-neutral-200/70 dark:bg-neutral-800" />
                </div>
              </div>
            ))}
          </div>
        )}
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
                data-index={vi.index}
                ref={rowVirtualizer.measureElement}
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
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`
                }}
                className={`flex items-start gap-3 border-b border-neutral-100 px-3 text-left transition-colors dark:border-neutral-900 ${
                  density === 'compact' ? 'py-2' : 'py-3'
                } ${
                  isSelected
                    ? 'bg-emerald-600/10 shadow-[inset_2px_0_0_0_theme(colors.emerald.600)]'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-900/60'
                }`}
              >
                {density === 'comfortable' && (
                  <div className="mt-0.5 h-10 w-10 flex-shrink-0 overflow-hidden rounded-md bg-neutral-100 dark:bg-neutral-800">
                    <BookmarkThumb bookmark={b} display={display} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    {b.favourited && (
                      <Icon
                        name="star-filled"
                        size={11}
                        className="translate-y-px text-amber-500"
                      />
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
                  {density === 'comfortable' && b.tags && b.tags.length > 0 && (
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
        {!active.isLoading && bookmarks.length === 0 && <EmptyState selection={selection} isSearching={isSearching} />}
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

/**
 * Empty states used to be one grey sentence. Each of these says what is
 * empty and what would fill it — the difference between "nothing here" and
 * "here is the thing you'd do next".
 */
function EmptyState({ selection, isSearching }: { selection: Selection; isSearching: boolean }): React.JSX.Element {
  const { icon, title, hint } = emptyCopy(selection, isSearching)
  return (
    <div className="px-6 py-12 text-center">
      <Icon name={icon} size={28} className="mx-auto mb-3 text-neutral-300 dark:text-neutral-700" />
      <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">{title}</p>
      <p className="mt-1 text-xs text-neutral-400">{hint}</p>
    </div>
  )
}

function emptyCopy(
  selection: Selection,
  isSearching: boolean
): { icon: 'search' | 'star' | 'archive' | 'folder' | 'tag' | 'library'; title: string; hint: string } {
  if (isSearching) {
    return { icon: 'search', title: 'No matches', hint: 'Search covers titles, content and notes across your whole library.' }
  }
  switch (selection.type) {
    case 'favourites':
      return { icon: 'star', title: 'No favourites yet', hint: 'Press F on a bookmark, or use the star in the detail pane.' }
    case 'archived':
      return { icon: 'archive', title: 'Nothing archived', hint: 'Archiving keeps a bookmark without it cluttering your library.' }
    case 'list':
      return { icon: 'folder', title: 'This list is empty', hint: 'Drag bookmarks onto the list in the sidebar to file them here.' }
    case 'tag':
      return { icon: 'tag', title: 'Nothing with this tag', hint: 'Add the tag from a bookmark’s detail pane to see it here.' }
    default:
      return { icon: 'library', title: 'No bookmarks yet', hint: 'Use New bookmark, or drop a PDF or image onto the window.' }
  }
}
