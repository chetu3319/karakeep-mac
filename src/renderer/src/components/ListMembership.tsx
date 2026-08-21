import React, { useMemo, useRef, useState } from 'react'
import { useAddBookmarkToList, useBookmarkLists, useLists, useRemoveBookmarkFromList } from '../lib/queries'
import { buildByParent, orderedChildren } from '../lib/listTree'
import type { KKList } from '../../../shared/types'
import { errMessage } from '../lib/errors'
import Icon from './Icon'

/**
 * Which lists this bookmark is filed under, each removable.
 *
 * Until now the only way to take a bookmark out of a list was to drag it
 * onto a *different* list and have the move's second half fire — so a
 * bookmark could never simply leave a list. This is the direct path, and it
 * works wherever the bookmark is being viewed from rather than only while
 * browsing the list it happens to be in.
 */
export default function ListMembership({ bookmarkId }: { bookmarkId: string }): React.JSX.Element {
  const membership = useBookmarkLists(bookmarkId)
  const allLists = useLists()
  const addToList = useAddBookmarkToList()
  const removeFromList = useRemoveBookmarkFromList()
  const [error, setError] = useState<string | null>(null)

  const memberOf = membership.data || []
  const memberIds = useMemo(() => new Set(memberOf.map((l) => l.id)), [memberOf])

  // Flattened depth-first so the picker reads like the sidebar tree rather
  // than an arbitrarily-ordered flat list.
  const addable = useMemo(() => {
    const lists = allLists.data || []
    const byParent = buildByParent(lists)
    const out: { list: KKList; depth: number }[] = []
    const walk = (parentKey: string, depth: number): void => {
      for (const l of orderedChildren(byParent.get(parentKey) || [], undefined)) {
        if (!memberIds.has(l.id)) out.push({ list: l, depth })
        walk(l.id, depth + 1)
      }
    }
    walk('root', 0)
    return out
  }, [allLists.data, memberIds])

  function remove(list: KKList): void {
    setError(null)
    removeFromList.mutate(
      { listId: list.id, bookmarkId },
      { onError: (err) => setError(`Couldn't remove it from "${list.name}". ${errMessage(err)}`) }
    )
  }

  function add(listId: string): void {
    if (!listId) return
    setError(null)
    addToList.mutate(
      { listId, bookmarkId },
      { onError: (err) => setError(`Couldn't add it to the list. ${errMessage(err)}`) }
    )
  }

  return (
    <div className="mb-4">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">Lists</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {memberOf.map((l) => (
          <span
            key={l.id}
            className="flex items-center gap-1 rounded-md bg-neutral-100 py-0.5 pl-2 pr-1 text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
          >
            {l.icon ? `${l.icon} ` : ''}
            {l.name}
            <button
              type="button"
              onClick={() => remove(l)}
              title={`Remove from "${l.name}"`}
              aria-label={`Remove from list ${l.name}`}
              className="rounded px-1 text-neutral-400 hover:bg-neutral-200 hover:text-red-600 dark:hover:bg-neutral-700 dark:hover:text-red-400"
            >
              ×
            </button>
          </span>
        ))}
        {memberOf.length === 0 && !membership.isLoading && (
          <span className="text-xs text-neutral-400">Not in any list.</span>
        )}
        {addable.length > 0 && <AddToListMenu addable={addable} onPick={add} />}
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}

/**
 * "Add to a list", as a menu rather than a native `<select>`.
 *
 * A `<select>` used as an action menu has two problems here. Visually it
 * is the one control macOS refuses to let a stylesheet touch, so it sat in
 * the middle of a row of pill chips looking like it came from a different
 * application — and it sized itself to its *longest option*, which on a
 * library with a wordy list name stretched a "+ List" affordance across
 * half the pane. Behaviourally, a select with no persistent value is a lie
 * about what the control is.
 *
 * This is a plain popover with the same tree indentation, plus a filter
 * box once there are enough lists for scanning to be work.
 */
function AddToListMenu({
  addable,
  onPick
}: {
  addable: { list: KKList; depth: number }[]
  onPick: (listId: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const needle = filter.trim().toLowerCase()
  const shown = needle ? addable.filter(({ list }) => list.name.toLowerCase().includes(needle)) : addable

  function close(): void {
    setOpen(false)
    setFilter('')
  }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-md border border-dashed border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-neutral-700 dark:hover:border-emerald-500 dark:hover:text-emerald-400"
      >
        <Icon name="plus" size={11} />
        List
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={close} role="presentation" />
          <div
            role="menu"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                close()
              }
            }}
            className="absolute left-0 top-full z-30 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
          >
            {addable.length > 8 && (
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter lists…"
                aria-label="Filter lists"
                className="mb-1 w-full rounded-md border border-neutral-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-emerald-500 dark:border-neutral-700"
              />
            )}
            {shown.map(({ list, depth }) => (
              <button
                key={list.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onPick(list.id)
                  close()
                }}
                style={{ paddingLeft: 8 + depth * 12 }}
                className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                {list.icon && <span aria-hidden>{list.icon}</span>}
                <span className="truncate">{list.name}</span>
              </button>
            ))}
            {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-neutral-400">No lists match.</p>}
          </div>
        </>
      )}
    </div>
  )
}
