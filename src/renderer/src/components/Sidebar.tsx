import React, { useMemo, useRef, useState } from 'react'
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
import type { KKList, KKTag } from '../../../shared/types'
import type { Selection } from '../lib/selection'
import { buildByParent, nestUnder, orderedChildren, reorderAsSibling, wouldCycle, moveToRoot } from '../lib/listTree'
import ConfirmDialog from './ConfirmDialog'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { BOOKMARK_DRAG_MIME, currentBookmarkDrag, type BookmarkDragPayload } from '../lib/dragTypes'
import { errMessage } from '../lib/errors'

const LIST_DRAG_MIME = 'application/x-karakeep-list'
const DEFAULT_LIST_ICON = '📁'

interface SidebarProps {
  selected: Selection
  onSelect: (sel: Selection) => void
}

// The three feed-backed views, in the order they appear above the list
// tree. Favourites and Archive are ordinary GET /bookmarks queries with a
// filter, not saved searches — see lib/selection.ts.
const FEED_VIEWS: { type: 'all' | 'favourites' | 'archived'; icon: string; label: string }[] = [
  { type: 'all', icon: '📚', label: 'All bookmarks' },
  { type: 'favourites', icon: '⭐', label: 'Favourites' },
  { type: 'archived', icon: '🗄', label: 'Archive' }
]

type DropMode = 'before' | 'after' | 'nest'
type DropHint = { targetId: string; mode: DropMode; label: string } | null

type MenuState = { x: number; y: number; kind: 'list' | 'tag'; id: string } | null
type DeleteState =
  | { kind: 'list'; id: string; name: string; childCount: number }
  | { kind: 'tag'; id: string; name: string }
  | null

export default function Sidebar({ selected, onSelect }: SidebarProps): React.JSX.Element {
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
      const rect = e.currentTarget.getBoundingClientRect()
      const relY = (e.clientY - rect.top) / rect.height
      const mode: DropMode = relY < 0.25 ? 'before' : relY > 0.75 ? 'after' : 'nest'
      setDropHint({
        targetId: target.id,
        mode,
        label: mode === 'nest' ? `Move into "${target.name}"` : mode === 'before' ? 'Move here' : 'Move here'
      })
    } else if (e.dataTransfer.types.includes(BOOKMARK_DRAG_MIME)) {
      e.preventDefault()
      e.stopPropagation()
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
      const rect = e.currentTarget.getBoundingClientRect()
      const relY = (e.clientY - rect.top) / rect.height
      const mode: DropMode = relY < 0.25 ? 'before' : relY > 0.75 ? 'after' : 'nest'

      if (mode === 'nest') {
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
    { label: 'New sublist', onSelect: () => setCreatingUnder(list.id) },
    { label: 'Rename', onSelect: () => setEditingListId(list.id) },
    { label: 'Delete', danger: true, onSelect: () => requestDeleteList(list) }
  ]

  const tagMenuItems = (tag: KKTag): ContextMenuItem[] => [
    { label: 'Rename', onSelect: () => setEditingTagId(tag.id) },
    { label: 'Delete', danger: true, onSelect: () => requestDeleteTag(tag) }
  ]

  return (
    <div
      className="flex h-full flex-col overflow-y-auto pb-4 pt-2"
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
            className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm ${
              selected.type === view.type
                ? 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400'
                : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
            }`}
          >
            <span aria-hidden>{view.icon}</span>
            {view.label}
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between px-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Lists</span>
        <button
          onClick={() => setCreatingUnder('root')}
          title="New list"
          className="rounded px-1.5 text-sm text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          +
        </button>
      </div>
      <div
        className={`mt-1 px-2 ${dropHint?.targetId === 'root' ? 'rounded-md bg-emerald-600/5 ring-1 ring-emerald-500/40' : ''}`}
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
            editingListId={editingListId}
            onStartRename={setEditingListId}
            onCommitRename={commitRename}
            onCancelRename={() => setEditingListId(null)}
            creatingUnder={creatingUnder}
            onCommitCreate={commitCreate}
            onCancelCreate={() => setCreatingUnder(null)}
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
        {listsQuery.isLoading && <div className="px-3 py-1 text-sm text-neutral-400">Loading…</div>}
      </div>

      <div className="mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        Tags
        <div className="mt-1 font-normal normal-case tracking-normal text-neutral-400/80">
          Tags are created by attaching them to a bookmark.
        </div>
      </div>
      <div className="mt-1 px-2">
        {tags.map((t) =>
          editingTagId === t.id ? (
            <InlineTextInput
              key={t.id}
              initial={t.name}
              className="px-3 py-1"
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
              className={`flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left text-sm ${
                selected.type === 'tag' && selected.id === t.id
                  ? 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400'
                  : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
              }`}
            >
              <span className="truncate">#{t.name}</span>
              {typeof t.numBookmarks === 'number' && (
                <span className="text-xs text-neutral-400">{t.numBookmarks}</span>
              )}
            </button>
          )
        )}
        {tagsQuery.isLoading && <div className="px-3 py-1 text-sm text-neutral-400">Loading…</div>}
      </div>

      {menu &&
        (menu.kind === 'list' ? (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={listMenuItems(lists.find((l) => l.id === menu.id)!)}
            onClose={() => setMenu(null)}
          />
        ) : (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={tagMenuItems(tags.find((t) => t.id === menu.id)!)}
            onClose={() => setMenu(null)}
          />
        ))}

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
    </div>
  )
}


function descendantCount(byParent: Map<string, KKList[]>, id: string): number {
  return (byParent.get(id) || []).length
}

function ListNode({
  list,
  byParent,
  order,
  depth,
  selected,
  onSelect,
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
          <div style={{ paddingLeft: 12 + depth * 14 }} className="py-0.5 pr-2">
            <InlineTextInput
              initial={list.name}
              onCommit={(name) => onCommitRename(list.id, name)}
              onCancel={onCancelRename}
            />
          </div>
        ) : (
          <button
            onClick={() => onSelect({ type: 'list', id: list.id })}
            onDoubleClick={(e) => {
              e.stopPropagation()
              onStartRename(list.id)
            }}
            style={{ paddingLeft: 12 + depth * 14 }}
            className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors ${
              isSelected
                ? 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400'
                : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
            } ${isDropTarget && dropHint?.mode === 'nest' ? 'ring-1 ring-emerald-500/60' : ''}`}
          >
            <span className="truncate">
              {list.icon ? `${list.icon} ` : `${DEFAULT_LIST_ICON} `}
              {list.name}
            </span>
            {isDropTarget && dropHint?.mode === 'nest' && (
              <span className="ml-auto flex-shrink-0 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                {dropHint.label}
              </span>
            )}
          </button>
        )}
      </div>
      {children.map((c) => (
        <ListNode
          key={c.id}
          list={c}
          byParent={byParent}
          order={order}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
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
    <div style={{ paddingLeft: 12 + depth * 14 }} className="py-0.5 pr-2">
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
