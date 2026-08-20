import React, { useMemo, useState } from 'react'
import { useAddBookmarkToList, useBookmarkLists, useLists, useRemoveBookmarkFromList } from '../lib/queries'
import { buildByParent, orderedChildren } from '../lib/listTree'
import type { KKList } from '../../../shared/types'
import { errMessage } from '../lib/errors'

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
        {addable.length > 0 && (
          <select
            // A select that never keeps a value: it's an action menu, not a
            // field. Resetting to "" after each pick means the same list can
            // be re-picked later without first choosing something else.
            value=""
            onChange={(e) => {
              add(e.target.value)
              e.target.value = ''
            }}
            aria-label="Add to a list"
            className="rounded-md border border-dashed border-neutral-300 bg-transparent px-1.5 py-0.5 text-xs text-neutral-500 outline-none hover:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="">+ List</option>
            {addable.map(({ list, depth }) => (
              <option key={list.id} value={list.id}>
                {'  '.repeat(depth)}
                {list.icon ? `${list.icon} ` : ''}
                {list.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}

