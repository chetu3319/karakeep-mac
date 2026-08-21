import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  useAddBookmarkToList,
  useCreateList,
  useDeleteList,
  useDeleteTag,
  useLists,
  useListOrder,
  useRemoveBookmarkFromList,
  useSetListOrder,
  useTags,
  useUpdateList,
  useUpdateTag
} from '../lib/queries'
import type { KKList, KKTag, User } from '../../../shared/types'
import type { Selection } from '../lib/selection'
import { buildByParent, nestUnder, orderedChildren, reorderAsSibling, wouldCycle, moveToRoot } from '../lib/listTree'
import { HIGHLIGHT_COLORS } from '../../../shared/highlightUi'
import { usePref, usePrefSet } from '../lib/prefs'
import ConfirmDialog from './ConfirmDialog'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import Icon, { type IconName } from './Icon'
import { BOOKMARK_DRAG_MIME, currentBookmarkDrag, type BookmarkDragPayload } from '../lib/dragTypes'
import { errMessage } from '../lib/errors'

const LIST_DRAG_MIME = 'application/x-karakeep-list'
const DEFAULT_LIST_ICON = '📁'
/** Tags past this many are hidden behind a "Show all" expander. */
const TAG_PREVIEW_COUNT = 10

interface SidebarProps {
  selected: Selection
  onSelect: (sel: Selection) => void
  user: User
  onAddBookmark: () => void
  onOpenSettings: () => void
  onSignOut: () => void
  onCollapse: () => void
}

// The three feed-backed views, in the order they appear above the list
// tree. Favourites and Archive are ordinary GET /bookmarks queries with a
// filter, not saved searches — see lib/selection.ts.
const FEED_VIEWS: { type: 'all' | 'favourites' | 'archived'; icon: IconName; label: string }[] = [
  { type: 'all', icon: 'library', label: 'All bookmarks' },
  { type: 'favourites', icon: 'star', label: 'Favourites' },
  { type: 'archived', icon: 'archive', label: 'Archive' }
]

/**
 * Smart lists are server-side saved queries: their membership is computed
 * from `query`, so adding a bookmark to one is meaningless and the server
 * rejects it. They used to render identically to manual lists and accept
 * drops, which meant dragging onto one produced a raw API error with no
 * hint as to why.
 */
function isSmartList(list: KKList): boolean {
  return !!list.type && list.type !== 'manual'
}

type DropMode = 'before' | 'after' | 'nest'
type DropHint = { targetId: string; mode: DropMode; label: string; invalid?: boolean } | null

type MenuState = { x: number; y: number; kind: 'list' | 'tag'; id: string } | null
type DeleteState =
  | { kind: 'list'; id: string; name: string; childCount: number }
  | { kind: 'tag'; id: string; name: string }
  | null

export default function Sidebar({
  selected,
  onSelect,
  user,
  onAddBookmark,
  onOpenSettings,
  onSignOut,
  onCollapse
}: SidebarProps): React.JSX.Element {
  const listsQuery = useLists()
  const tagsQuery = useTags()
  const orderQuery = useListOrder()
  const lists = listsQuery.data || []
  const tags = tagsQuery.data || []
  const order = orderQuery.data || {}

  const createList = useCreateList()
  const updateList = useUpdateList()
  const deleteList = useDeleteList()
  const setListOrder = useSetListOrder()
  const addBookmarkToList = useAddBookmarkToList()
  const removeBookmarkFromList = useRemoveBookmarkFromList()
  const updateTag = useUpdateTag()
  const deleteTag = useDeleteTag()

  const byParent = useMemo(() => buildByParent(lists), [lists])
  const roots = useMemo(() => orderedChildren(byParent.get('root') || [], order['root']), [byParent, order])

  const [editingListId, setEditingListId] = useState<string | null>(null)
  const [creatingUnder, setCreatingUnder] = useState<string | 'root' | null>(null)
  const [editingTagId, setEditingTagId] = useState<string | null>(null)
  const [draggedListId, setDraggedListId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<DropHint>(null)
  const [menu, setMenu] = useState<MenuState>(null)
  const [pendingDelete, setPendingDelete] = useState<DeleteState>(null)
  const [dropError, setDropError] = useState<string | null>(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)

  // ── Collapsible chrome ──
  // Section headers and tree nodes both persist their disclosure state, so
  // a sidebar arranged once stays arranged. Sections default open; tree
  // nodes default *closed*, which is the whole point — a five-list library
  // was rendering fourteen always-visible rows.
  const sections = usePrefSet('sidebarSectionsCollapsed')
  const expanded = usePrefSet('listExpanded')
  const [tagsExpanded, setTagsExpanded] = usePref('tagsExpanded', false)
  const [tagFilter, setTagFilter] = useState('')

  // Reveal the selected list by opening its ancestors. Without this a
  // selection restored at launch (or made from the detail pane's list
  // chips) can sit inside a collapsed branch, so the sidebar shows nothing
  // highlighted while the list pane shows that list's bookmarks.
  const parentOf = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const l of lists) map.set(l.id, l.parentId ?? null)
    return map
  }, [lists])

  const expandRef = useRef(expanded)
  expandRef.current = expanded
  useEffect(() => {
    if (selected.type !== 'list') return
    let cursor = parentOf.get(selected.id) ?? null
    const guard = new Set<string>()
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor)
      expandRef.current.set(cursor, true)
      cursor = parentOf.get(cursor) ?? null
    }
  }, [selected, parentOf])

  const visibleTags = useMemo(() => {
    const needle = tagFilter.trim().toLowerCase()
    const matched = needle ? tags.filter((t) => t.name.toLowerCase().includes(needle)) : tags
    // Busiest first. The server returns them in its own order, which for a
    // library with 40 tags means the ones you actually use are scattered
    // through an alphabetical wall.
    return [...matched].sort((a, b) => (b.numBookmarks ?? 0) - (a.numBookmarks ?? 0))
  }, [tags, tagFilter])

  // A filter is itself a way of finding a tag, so don't also make the user
  // press "Show all" to see what it matched.
  const shownTags = tagsExpanded || tagFilter.trim() ? visibleTags : visibleTags.slice(0, TAG_PREVIEW_COUNT)

  const highlightColors = selected.type === 'highlights' ? selected.colors : []

  function toggleHighlightColor(name: string): void {
    const next = highlightColors.includes(name)
      ? highlightColors.filter((c) => c !== name)
      : [...highlightColors, name]
    onSelect({ type: 'highlights', colors: next })
  }

  function commitRename(id: string, name: string): void {
    const trimmed = name.trim()
    setEditingListId(null)
    if (!trimmed) return
    const current = lists.find((l) => l.id === id)
    if (!current || current.name === trimmed) return
    updateList.mutate({ id, input: { name: trimmed } })
  }

  function commitCreate(parentKeyValue: string | 'root', name: string): void {
    setCreatingUnder(null)
    const trimmed = name.trim()
    if (!trimmed) return
    const parentId = parentKeyValue === 'root' ? null : parentKeyValue
    // A sublist created under a collapsed parent would otherwise be
    // invisible the moment it is created.
    if (parentId) expanded.set(parentId, true)
    createList.mutate({ name: trimmed, icon: DEFAULT_LIST_ICON, parentId })
  }

  function requestDeleteList(list: KKList): void {
    const childCount = descendantCount(byParent, list.id)
    setPendingDelete({ kind: 'list', id: list.id, name: list.name, childCount })
  }

  function requestDeleteTag(tag: KKTag): void {
    setPendingDelete({ kind: 'tag', id: tag.id, name: tag.name })
  }

  function confirmDelete(): void {
    if (!pendingDelete) return
    if (pendingDelete.kind === 'list') {
      deleteList.mutate(pendingDelete.id)
      if (selected.type === 'list' && selected.id === pendingDelete.id) onSelect({ type: 'all' })
    } else {
      deleteTag.mutate(pendingDelete.id)
      if (selected.type === 'tag' && selected.id === pendingDelete.id) onSelect({ type: 'all' })
    }
    setPendingDelete(null)
  }

  // ── Drag handling for list nesting/reordering ──
  function onListDragStart(e: React.DragEvent, list: KKList): void {
    e.dataTransfer.setData(LIST_DRAG_MIME, JSON.stringify({ id: list.id }))
    e.dataTransfer.effectAllowed = 'move'
    setDraggedListId(list.id)
  }

  function onListDragEnd(): void {
    setDraggedListId(null)
    setDropHint(null)
  }

  function onListDragOver(e: React.DragEvent, target: KKList): void {
    if (e.dataTransfer.types.includes(LIST_DRAG_MIME)) {
      e.preventDefault()
      // A row that recognizes the drag must claim it — otherwise this
      // dragover also bubbles to the scroll container's onRootDragOver,
      // which fights this handler over dropHint (root wants 'Move to top
      // level' while this row wants 'nest'/'before'/'after' on the same
      // pixel).
      e.stopPropagation()
      if (!draggedListId || wouldCycle(byParent, draggedListId, target.id)) {
        e.dataTransfer.dropEffect = 'none'
        setDropHint(null)
        return
      }
      e.dataTransfer.dropEffect = 'move'
      const mode = dropModeFor(e)
      // Nesting *under* a smart list is meaningless in the same way
      // filing into one is: its children would not be part of its query.
      if (mode === 'nest' && isSmartList(target)) {
        e.dataTransfer.dropEffect = 'none'
        setDropHint({ targetId: target.id, mode, label: 'Smart lists can’t hold sublists', invalid: true })
        return
      }
      setDropHint({
        targetId: target.id,
        mode,
        label: mode === 'nest' ? `Move into "${target.name}"` : 'Move here'
      })
    } else if (e.dataTransfer.types.includes(BOOKMARK_DRAG_MIME)) {
      e.preventDefault()
      e.stopPropagation()
      if (isSmartList(target)) {
        e.dataTransfer.dropEffect = 'none'
        setDropHint({ targetId: target.id, mode: 'nest', label: 'Smart list — updates automatically', invalid: true })
        return
      }
      const effect = describeBookmarkDropEffect(e, target.id)
      e.dataTransfer.dropEffect = effect.dropEffect
      setDropHint({ targetId: target.id, mode: 'nest', label: effect.label })
    }
  }

  function onListDrop(e: React.DragEvent, target: KKList): void {
    if (e.dataTransfer.types.includes(LIST_DRAG_MIME)) {
      e.preventDefault()
      // Without this, the drop also reaches onRootDrop on the scroll
      // container (native DnD events bubble like any other DOM event).
      // onRootDrop's own parentId!=null guard only happens to save a
      // *top-level* drag from being no-op'd back to root — for a nested
      // list being re-nested onto a sibling, that guard doesn't fire, so
      // the bubbled onRootDrop would immediately re-PATCH parentId: null
      // and undo the nest that just happened one line above it.
      e.stopPropagation()
      const raw = e.dataTransfer.getData(LIST_DRAG_MIME)
      setDropHint(null)
      setDraggedListId(null)
      if (!raw) return
      const { id: draggedId } = JSON.parse(raw) as { id: string }
      if (wouldCycle(byParent, draggedId, target.id)) return
      const mode = dropModeFor(e)
      if (mode === 'nest' && isSmartList(target)) return

      if (mode === 'nest') {
        expanded.set(target.id, true)
        const result = nestUnder(lists, order, draggedId, target.id)
        setListOrder.mutate(result.order)
        const draggedList = lists.find((l) => l.id === draggedId)
        if (draggedList && (draggedList.parentId ?? null) !== result.newParentId) {
          updateList.mutate({ id: draggedId, input: { parentId: result.newParentId } })
        }
      } else {
        const result = reorderAsSibling(lists, order, draggedId, target.id, mode)
        setListOrder.mutate(result.order)
        const draggedList = lists.find((l) => l.id === draggedId)
        if (draggedList && (draggedList.parentId ?? null) !== result.newParentId) {
          updateList.mutate({ id: draggedId, input: { parentId: result.newParentId } })
        }
      }
    } else if (e.dataTransfer.types.includes(BOOKMARK_DRAG_MIME)) {
      e.preventDefault()
      e.stopPropagation()
      setDropHint(null)
      if (isSmartList(target)) return
      const raw = e.dataTransfer.getData(BOOKMARK_DRAG_MIME)
      if (!raw) return
      void handleBookmarkDrop(JSON.parse(raw) as BookmarkDragPayload, target.id, e.altKey)
    }
  }

  function describeBookmarkDropEffect(e: React.DragEvent, targetListId: string): { dropEffect: 'copy' | 'move'; label: string } {
    // dataTransfer.getData() is unreadable during dragover in most browsers
    // (only .types is), so this reads the payload cached on dragstart via a
    // module-level ref instead of trying getData() here.
    const payload = currentBookmarkDrag.current
    const isMoveCandidate = payload?.sourceType === 'list' && payload.sourceId !== targetListId
    if (!isMoveCandidate) return { dropEffect: 'copy', label: 'Add to list' }
    return e.altKey ? { dropEffect: 'copy', label: 'Copy to list' } : { dropEffect: 'move', label: 'Move to list' }
  }

  async function handleBookmarkDrop(payload: BookmarkDragPayload, targetListId: string, altKey: boolean): Promise<void> {
    const isSelfDrop = payload.sourceType === 'list' && payload.sourceId === targetListId
    if (isSelfDrop) return // already there — dropping it back onto its own source list is a no-op
    const isMove = payload.sourceType === 'list' && payload.sourceId !== targetListId && !altKey

    setDropError(null)
    try {
      // The remove must never fire before we know the add landed — two
      // independent fire-and-forget mutations would race, and a failed add
      // followed by an unconditional remove deletes the bookmark from the
      // source list without it ever reaching the target: silent data loss
      // on a real personal library. So: await the add, and only proceed to
      // the remove if it actually succeeded.
      await addBookmarkToList.mutateAsync({ listId: targetListId, bookmarkId: payload.bookmarkId })
    } catch (err) {
      setDropError(`Couldn't add the bookmark to the list — nothing was moved. ${errMessage(err)}`)
      return
    }

    if (isMove && payload.sourceId) {
      try {
        await removeBookmarkFromList.mutateAsync({ listId: payload.sourceId, bookmarkId: payload.bookmarkId })
      } catch (err) {
        // The add already succeeded, so nothing was lost — the bookmark is
        // just in both lists now. That's a self-correcting state (remove
        // it from the source by hand), not a failed move, so say so rather
        // than reporting this as an outright failure.
        setDropError(
          `Added to the target list, but couldn't remove it from the source list — it's in both for now. ${errMessage(err)}`
        )
      }
    }
  }

  // Root-level drop zone: un-nest a list to the top level.
  function onRootDragOver(e: React.DragEvent): void {
    if (!e.dataTransfer.types.includes(LIST_DRAG_MIME)) return
    e.preventDefault()
    if (!draggedListId) return
    e.dataTransfer.dropEffect = 'move'
    setDropHint({ targetId: 'root', mode: 'nest', label: 'Move to top level' })
  }
  function onRootDrop(e: React.DragEvent): void {
    if (!e.dataTransfer.types.includes(LIST_DRAG_MIME)) return
    e.preventDefault()
    setDropHint(null)
    const raw = e.dataTransfer.getData(LIST_DRAG_MIME)
    if (!raw) return
    const { id: draggedId } = JSON.parse(raw) as { id: string }
    const draggedList = lists.find((l) => l.id === draggedId)
    if (!draggedList || draggedList.parentId == null) return
    const result = moveToRoot(lists, order, draggedId)
    setListOrder.mutate(result.order)
    updateList.mutate({ id: draggedId, input: { parentId: null } })
  }

  const listMenuItems = (list: KKList): ContextMenuItem[] => [
    ...(isSmartList(list) ? [] : [{ label: 'New sublist', onSelect: (): void => setCreatingUnder(list.id) }]),
    { label: 'Rename', onSelect: () => setEditingListId(list.id) },
    { label: 'Delete', danger: true, onSelect: () => requestDeleteList(list) }
  ]

  const tagMenuItems = (tag: KKTag): ContextMenuItem[] => [
    { label: 'Rename', onSelect: () => setEditingTagId(tag.id) },
    { label: 'Delete', danger: true, onSelect: () => requestDeleteTag(tag) }
  ]

  return (
    <aside className="flex h-full flex-col border-r border-neutral-200 bg-neutral-50/60 dark:border-neutral-800 dark:bg-neutral-900/40">
      {/*
        The window's own title area. With `titleBarStyle: 'hiddenInset'`
        the traffic lights float over the renderer at
        trafficLightPosition (see main/index.ts), so the sidebar reserves
        the height and the left inset for them and takes over the drag
        region. This is what replaced the full-width header bar: on a
        1280px window that bar spent roughly 900px saying nothing.
      */}
      <div className="titlebar-drag flex h-[52px] flex-shrink-0 items-center justify-end pl-[86px] pr-2">
        <button
          type="button"
          onClick={onCollapse}
          title="Hide sidebar (⌃⌘S)"
          aria-label="Hide sidebar"
          className="titlebar-no-drag rounded-md p-1.5 text-neutral-400 hover:bg-neutral-200/70 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <Icon name="chevron-left" />
        </button>
      </div>

      <div className="titlebar-no-drag px-2 pb-2">
        <button
          onClick={onAddBookmark}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
        >
          <Icon name="plus" size={15} />
          New bookmark
        </button>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto pb-3"
        onDragOver={onRootDragOver}
        onDrop={onRootDrop}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHint(null)
        }}
      >
        {dropError && (
          <div className="mx-2 mb-2 flex items-start justify-between gap-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-400">
            <span>{dropError}</span>
            <button onClick={() => setDropError(null)} className="flex-shrink-0 font-medium hover:underline">
              Dismiss
            </button>
          </div>
        )}

        <div className="px-2">
          {FEED_VIEWS.map((view) => (
            <button
              key={view.type}
              onClick={() => onSelect({ type: view.type })}
              data-testid={`sidebar-view-${view.type}`}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${
                selected.type === view.type
                  ? 'bg-emerald-600/10 font-medium text-emerald-700 dark:text-emerald-400'
                  : 'text-neutral-700 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
              }`}
            >
              <Icon name={view.icon} />
              {view.label}
            </button>
          ))}
        </div>

        <Section
          id="lists"
          title="Lists"
          collapsed={sections.has('lists')}
          onToggle={() => sections.toggle('lists')}
          action={{ icon: 'plus', label: 'New list', onClick: () => setCreatingUnder('root') }}
        >
          <div
            className={`px-2 ${dropHint?.targetId === 'root' ? 'rounded-md bg-emerald-600/5 ring-1 ring-emerald-500/40' : ''}`}
          >
            {roots.map((l) => (
              <ListNode
                key={l.id}
                list={l}
                byParent={byParent}
                order={order}
                depth={0}
                selected={selected}
                onSelect={onSelect}
                isExpanded={expanded.has(l.id)}
                onToggleExpanded={(id) => expanded.toggle(id)}
                editingListId={editingListId}
                onStartRename={setEditingListId}
                onCommitRename={commitRename}
                onCancelRename={() => setEditingListId(null)}
                creatingUnder={creatingUnder}
                onCommitCreate={commitCreate}
                onCancelCreate={() => setCreatingUnder(null)}
                expandedSet={expanded}
                draggedListId={draggedListId}
                dropHint={dropHint}
                onListDragStart={onListDragStart}
                onListDragEnd={onListDragEnd}
                onListDragOver={onListDragOver}
                onListDrop={onListDrop}
                onContextMenu={(e, list) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, kind: 'list', id: list.id })
                }}
              />
            ))}
            {creatingUnder === 'root' && (
              <InlineListInput
                depth={0}
                onCommit={(name) => commitCreate('root', name)}
                onCancel={() => setCreatingUnder(null)}
              />
            )}
            {listsQuery.isLoading && <SkeletonRows count={4} />}
            {!listsQuery.isLoading && roots.length === 0 && creatingUnder !== 'root' && (
              <p className="px-2.5 py-1.5 text-xs text-neutral-400">
                No lists yet. Use + to make one, then drag bookmarks onto it.
              </p>
            )}
          </div>
        </Section>

        <Section
          id="highlights"
          title="Highlights"
          collapsed={sections.has('highlights')}
          onToggle={() => sections.toggle('highlights')}
        >
          <div className="px-2">
            <button
              onClick={() => onSelect({ type: 'highlights', colors: highlightColors })}
              data-testid="sidebar-view-highlights"
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${
                selected.type === 'highlights'
                  ? 'bg-emerald-600/10 font-medium text-emerald-700 dark:text-emerald-400'
                  : 'text-neutral-700 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
              }`}
            >
              <Icon name="highlight" />
              All highlights
            </button>
            {/*
              Colour is the only axis Karakeep gives highlights, and it is
              the one people actually use as a taxonomy (yellow = quote,
              red = disagree, and so on). Multi-select: picking two colours
              shows both rather than replacing the filter.
            */}
            <div className="mt-1.5 flex items-center gap-1 px-2.5 pb-0.5" role="group" aria-label="Filter highlights by colour">
              {HIGHLIGHT_COLORS.map((c) => {
                const on = highlightColors.includes(c.name)
                return (
                  <button
                    key={c.name}
                    type="button"
                    onClick={() => toggleHighlightColor(c.name)}
                    aria-pressed={on}
                    title={`${on ? 'Remove' : 'Add'} ${c.name} filter`}
                    className={`grid h-6 w-6 place-items-center rounded-md transition-colors ${
                      on ? 'bg-neutral-200 dark:bg-neutral-700' : 'hover:bg-neutral-200/70 dark:hover:bg-neutral-800'
                    }`}
                  >
                    <span
                      className={`block h-3 w-3 rounded-full ${on ? 'ring-2 ring-neutral-500/60 ring-offset-1 ring-offset-neutral-50 dark:ring-offset-neutral-900' : ''}`}
                      style={{ backgroundColor: c.hex }}
                    />
                    <span className="sr-only">{c.name}</span>
                  </button>
                )
              })}
              {highlightColors.length > 0 && (
                <button
                  type="button"
                  onClick={() => onSelect({ type: 'highlights', colors: [] })}
                  title="Clear colour filter"
                  aria-label="Clear colour filter"
                  className="ml-0.5 grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-neutral-200/70 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  <Icon name="close" size={13} />
                </button>
              )}
            </div>
          </div>
        </Section>

        <Section
          id="tags"
          title="Tags"
          collapsed={sections.has('tags')}
          onToggle={() => sections.toggle('tags')}
        >
          <div className="px-2">
            {tags.length > TAG_PREVIEW_COUNT && (
              <input
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                placeholder="Filter tags…"
                aria-label="Filter tags"
                className="mb-1 w-full rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs outline-none focus:border-emerald-500 dark:border-neutral-800 dark:bg-neutral-900"
              />
            )}
            {shownTags.map((t) =>
              editingTagId === t.id ? (
                <InlineTextInput
                  key={t.id}
                  initial={t.name}
                  className="px-2.5 py-1"
                  onCommit={(name) => {
                    setEditingTagId(null)
                    const trimmed = name.trim()
                    if (trimmed && trimmed !== t.name) updateTag.mutate({ id: t.id, input: { name: trimmed } })
                  }}
                  onCancel={() => setEditingTagId(null)}
                />
              ) : (
                <button
                  key={t.id}
                  onClick={() => onSelect({ type: 'tag', id: t.id })}
                  onDoubleClick={() => setEditingTagId(t.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, kind: 'tag', id: t.id })
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${
                    selected.type === 'tag' && selected.id === t.id
                      ? 'bg-emerald-600/10 font-medium text-emerald-700 dark:text-emerald-400'
                      : 'text-neutral-700 hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
                  }`}
                >
                  <span className="truncate">#{t.name}</span>
                  {typeof t.numBookmarks === 'number' && (
                    <span className="flex-shrink-0 text-xs tabular-nums text-neutral-400">{t.numBookmarks}</span>
                  )}
                </button>
              )
            )}
            {tagsQuery.isLoading && <SkeletonRows count={3} />}
            {!tagsQuery.isLoading && visibleTags.length > TAG_PREVIEW_COUNT && !tagFilter.trim() && (
              <button
                onClick={() => setTagsExpanded(!tagsExpanded)}
                className="mt-0.5 w-full rounded-md px-2.5 py-1 text-left text-xs text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-700 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-300"
              >
                {tagsExpanded ? 'Show fewer' : `Show all ${visibleTags.length}`}
              </button>
            )}
            {!tagsQuery.isLoading && visibleTags.length === 0 && (
              <p className="px-2.5 py-1.5 text-xs text-neutral-400">
                {tagFilter.trim() ? 'No tags match.' : 'Tags appear here once you attach one to a bookmark.'}
              </p>
            )}
          </div>
        </Section>
      </div>

      {/* Account. The email and Sign out used to sit permanently in the
          window chrome, where Sign out was a single unconfirmed click
          away at all times. */}
      <div className="relative flex-shrink-0 border-t border-neutral-200 p-2 dark:border-neutral-800">
        {accountMenuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setAccountMenuOpen(false)} role="presentation" />
            <div className="absolute bottom-full left-2 right-2 z-20 mb-1 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
              <button
                onClick={() => {
                  setAccountMenuOpen(false)
                  onOpenSettings()
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                <Icon name="settings" size={14} />
                Settings…
              </button>
              <button
                onClick={() => {
                  setAccountMenuOpen(false)
                  onSignOut()
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                <Icon name="external" size={14} />
                Sign out…
              </button>
            </div>
          </>
        )}
        <button
          onClick={() => setAccountMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={accountMenuOpen}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-neutral-200/60 dark:hover:bg-neutral-800/60"
        >
          <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-emerald-600/15 text-[11px] font-semibold uppercase text-emerald-700 dark:text-emerald-400">
            {(user.name || user.email || '?').slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-600 dark:text-neutral-400">
            {user.email || user.name}
          </span>
          <Icon name="chevron-down" size={14} className="text-neutral-400" />
        </button>
      </div>

      {menu &&
        (menu.kind === 'list'
          ? (() => {
              const list = lists.find((l) => l.id === menu.id)
              return list ? (
                <ContextMenu x={menu.x} y={menu.y} items={listMenuItems(list)} onClose={() => setMenu(null)} />
              ) : null
            })()
          : (() => {
              const tag = tags.find((t) => t.id === menu.id)
              return tag ? (
                <ContextMenu x={menu.x} y={menu.y} items={tagMenuItems(tag)} onClose={() => setMenu(null)} />
              ) : null
            })())}

      {pendingDelete && pendingDelete.kind === 'list' && (
        <ConfirmDialog
          title={`Delete "${pendingDelete.name}"?`}
          description={
            <>
              <p>Its bookmarks will not be deleted — only removed from this list.</p>
              {pendingDelete.childCount > 0 && (
                <p className="mt-2">
                  Its {pendingDelete.childCount} sublist{pendingDelete.childCount === 1 ? '' : 's'} will not be
                  deleted — {pendingDelete.childCount === 1 ? 'it moves' : 'they move'} up to the top level. (Verified
                  against the server: deleting a parent reparents its direct children to root rather than cascading.)
                </p>
              )}
            </>
          }
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {pendingDelete && pendingDelete.kind === 'tag' && (
        <ConfirmDialog
          title={`Delete tag "#${pendingDelete.name}"?`}
          description="This removes the tag from every bookmark it's attached to. The bookmarks themselves are not deleted."
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </aside>
  )
}

/** Where in a row the pointer is, in thirds: reorder above / nest / reorder below. */
function dropModeFor(e: React.DragEvent): DropMode {
  const rect = e.currentTarget.getBoundingClientRect()
  const relY = (e.clientY - rect.top) / rect.height
  return relY < 0.25 ? 'before' : relY > 0.75 ? 'after' : 'nest'
}

function descendantCount(byParent: Map<string, KKList[]>, id: string): number {
  return (byParent.get(id) || []).length
}

/**
 * A collapsible sidebar section. The whole header is the toggle — a 20px
 * disclosure triangle on its own is a miserable target — with any
 * secondary action (the Lists "+") sitting outside the button so clicking
 * it doesn't also collapse the thing it just added to.
 */
function Section({
  id,
  title,
  collapsed,
  onToggle,
  action,
  children
}: {
  id: string
  title: string
  collapsed: boolean
  onToggle: () => void
  action?: { icon: IconName; label: string; onClick: () => void }
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mt-3">
      <div className="flex items-center gap-0.5 pl-1 pr-2">
        <button
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={`section-${id}`}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs font-semibold uppercase tracking-wide text-neutral-400 hover:bg-neutral-200/60 hover:text-neutral-600 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-300"
        >
          <Icon
            name="chevron-down"
            size={13}
            className={`transition-transform ${collapsed ? '-rotate-90' : ''}`}
          />
          <span className="truncate">{title}</span>
        </button>
        {action && (
          <button
            onClick={action.onClick}
            title={action.label}
            aria-label={action.label}
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-neutral-200/60 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <Icon name={action.icon} size={15} />
          </button>
        )}
      </div>
      <div id={`section-${id}`} hidden={collapsed} className="mt-0.5">
        {children}
      </div>
    </div>
  )
}

function SkeletonRows({ count }: { count: number }): React.JSX.Element {
  return (
    <div className="space-y-1.5 px-2.5 py-1.5" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="h-3.5 animate-pulse rounded bg-neutral-200/70 dark:bg-neutral-800"
          style={{ width: `${85 - i * 12}%` }}
        />
      ))}
    </div>
  )
}

function ListNode({
  list,
  byParent,
  order,
  depth,
  selected,
  onSelect,
  isExpanded,
  onToggleExpanded,
  expandedSet,
  editingListId,
  onStartRename,
  onCommitRename,
  onCancelRename,
  creatingUnder,
  onCommitCreate,
  onCancelCreate,
  draggedListId,
  dropHint,
  onListDragStart,
  onListDragEnd,
  onListDragOver,
  onListDrop,
  onContextMenu
}: {
  list: KKList
  byParent: Map<string, KKList[]>
  order: Record<string, string[]>
  depth: number
  selected: SidebarProps['selected']
  onSelect: SidebarProps['onSelect']
  isExpanded: boolean
  onToggleExpanded: (id: string) => void
  expandedSet: ReturnType<typeof usePrefSet>
  editingListId: string | null
  onStartRename: (id: string) => void
  onCommitRename: (id: string, name: string) => void
  onCancelRename: () => void
  creatingUnder: string | 'root' | null
  onCommitCreate: (parentKeyValue: string | 'root', name: string) => void
  onCancelCreate: () => void
  draggedListId: string | null
  dropHint: DropHint
  onListDragStart: (e: React.DragEvent, list: KKList) => void
  onListDragEnd: () => void
  onListDragOver: (e: React.DragEvent, target: KKList) => void
  onListDrop: (e: React.DragEvent, target: KKList) => void
  onContextMenu: (e: React.MouseEvent, list: KKList) => void
}): React.JSX.Element {
  const children = useMemo(
    () => orderedChildren(byParent.get(list.id) || [], order[list.id]),
    [byParent, order, list.id]
  )
  const isSelected = selected.type === 'list' && selected.id === list.id
  const isDragging = draggedListId === list.id
  const isDropTarget = dropHint?.targetId === list.id
  const isEditing = editingListId === list.id
  const smart = isSmartList(list)
  const hasChildren = children.length > 0
  // A branch being created into must be open to show the input, even if
  // the user had it collapsed a moment ago.
  const showChildren = (isExpanded || creatingUnder === list.id) && (hasChildren || creatingUnder === list.id)

  return (
    <div>
      <div
        draggable
        onDragStart={(e) => onListDragStart(e, list)}
        onDragEnd={onListDragEnd}
        onDragOver={(e) => onListDragOver(e, list)}
        onDrop={(e) => onListDrop(e, list)}
        onContextMenu={(e) => onContextMenu(e, list)}
        className={`relative ${isDragging ? 'opacity-40' : ''}`}
      >
        {isDropTarget && dropHint?.mode === 'before' && (
          <div className="absolute -top-0.5 left-2 right-2 h-0.5 rounded bg-emerald-500" />
        )}
        {isDropTarget && dropHint?.mode === 'after' && (
          <div className="absolute -bottom-0.5 left-2 right-2 h-0.5 rounded bg-emerald-500" />
        )}
        {isEditing ? (
          <div style={{ paddingLeft: 10 + depth * 14 }} className="py-0.5 pr-2">
            <InlineTextInput
              initial={list.name}
              onCommit={(name) => onCommitRename(list.id, name)}
              onCancel={onCancelRename}
            />
          </div>
        ) : (
          <div
            style={{ paddingLeft: depth * 14 }}
            className={`flex items-center rounded-md ${
              isSelected ? 'bg-emerald-600/10' : 'hover:bg-neutral-200/60 dark:hover:bg-neutral-800/60'
            } ${
              isDropTarget && dropHint?.mode === 'nest'
                ? dropHint.invalid
                  ? 'ring-1 ring-red-400/60'
                  : 'ring-1 ring-emerald-500/60'
                : ''
            }`}
          >
            {/* The disclosure triangle is its own control: clicking it must
                open the branch without also navigating to the list, and
                clicking the name must navigate without collapsing what you
                were looking at. Leaf lists get a matching spacer so every
                name in a branch starts on the same x. */}
            {hasChildren ? (
              <button
                onClick={() => onToggleExpanded(list.id)}
                aria-label={isExpanded ? `Collapse ${list.name}` : `Expand ${list.name}`}
                aria-expanded={isExpanded}
                className="grid h-7 w-6 flex-shrink-0 place-items-center rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <Icon
                  name="chevron-down"
                  size={13}
                  className={`transition-transform ${isExpanded ? '' : '-rotate-90'}`}
                />
              </button>
            ) : (
              <span className="h-7 w-6 flex-shrink-0" aria-hidden />
            )}
            <button
              onClick={() => onSelect({ type: 'list', id: list.id })}
              onDoubleClick={(e) => {
                e.stopPropagation()
                onStartRename(list.id)
              }}
              title={smart ? `${list.name} — smart list` : list.name}
              className={`flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left text-sm ${
                isSelected
                  ? 'font-medium text-emerald-700 dark:text-emerald-400'
                  : 'text-neutral-700 dark:text-neutral-300'
              }`}
            >
              {list.icon ? (
                <span className="flex-shrink-0" aria-hidden>
                  {list.icon}
                </span>
              ) : (
                <span className="flex-shrink-0" aria-hidden>
                  {DEFAULT_LIST_ICON}
                </span>
              )}
              <span className="truncate">{list.name}</span>
              {smart && (
                <Icon
                  name="sparkles"
                  size={12}
                  className="flex-shrink-0 text-neutral-400"
                />
              )}
              {isDropTarget && dropHint?.mode === 'nest' && (
                <span
                  className={`ml-auto flex-shrink-0 whitespace-nowrap text-[10px] font-medium ${
                    dropHint.invalid ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  {dropHint.label}
                </span>
              )}
            </button>
          </div>
        )}
      </div>
      {showChildren && (
        <>
          {children.map((c) => (
            <ListNode
              key={c.id}
              list={c}
              byParent={byParent}
              order={order}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              isExpanded={expandedSet.has(c.id)}
              onToggleExpanded={onToggleExpanded}
              expandedSet={expandedSet}
              editingListId={editingListId}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              creatingUnder={creatingUnder}
              onCommitCreate={onCommitCreate}
              onCancelCreate={onCancelCreate}
              draggedListId={draggedListId}
              dropHint={dropHint}
              onListDragStart={onListDragStart}
              onListDragEnd={onListDragEnd}
              onListDragOver={onListDragOver}
              onListDrop={onListDrop}
              onContextMenu={onContextMenu}
            />
          ))}
          {creatingUnder === list.id && (
            <InlineListInput
              depth={depth + 1}
              onCommit={(name) => onCommitCreate(list.id, name)}
              onCancel={onCancelCreate}
            />
          )}
        </>
      )}
    </div>
  )
}

function InlineListInput({
  depth,
  onCommit,
  onCancel
}: {
  depth: number
  onCommit: (name: string) => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div style={{ paddingLeft: 10 + depth * 14 }} className="py-0.5 pr-2">
      <InlineTextInput initial="" placeholder="List name" onCommit={onCommit} onCancel={onCancel} />
    </div>
  )
}

function InlineTextInput({
  initial,
  placeholder,
  className,
  onCommit,
  onCancel
}: {
  initial: string
  placeholder?: string
  className?: string
  onCommit: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const committedRef = useRef(false)

  return (
    <input
      ref={ref}
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          committedRef.current = true
          onCommit(value)
        } else if (e.key === 'Escape') {
          // Not a dialog Escape — stop it here so it doesn't also reach a
          // surrounding handler and close something the user still wants.
          e.stopPropagation()
          committedRef.current = true
          onCancel()
        }
      }}
      onBlur={() => {
        // Enter/Escape already resolved the input — a blur that follows
        // (e.g. focus moving to the confirm click) must not re-fire and
        // double-commit or stomp the cancel.
        if (committedRef.current) return
        committedRef.current = true
        onCommit(value)
      }}
      className={`w-full rounded-md border border-emerald-500 bg-white px-2 py-1 text-sm outline-none dark:bg-neutral-900 ${className || ''}`}
    />
  )
}
