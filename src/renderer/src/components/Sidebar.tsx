import React, { useMemo } from 'react'
import { useLists, useTags } from '../lib/queries'
import type { KKList, KKTag } from '../../../shared/types'

interface SidebarProps {
  selected: { type: 'all' } | { type: 'list'; id: string } | { type: 'tag'; id: string }
  onSelect: (sel: SidebarProps['selected']) => void
}

function buildTree(lists: KKList[]): Map<string | null, KKList[]> {
  const byParent = new Map<string | null, KKList[]>()
  for (const l of lists) {
    const key = l.parentId ?? null
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(l)
  }
  return byParent
}

function ListNode({
  list,
  byParent,
  depth,
  selected,
  onSelect
}: {
  list: KKList
  byParent: Map<string | null, KKList[]>
  depth: number
  selected: SidebarProps['selected']
  onSelect: SidebarProps['onSelect']
}): React.JSX.Element {
  const children = byParent.get(list.id) || []
  const isSelected = selected.type === 'list' && selected.id === list.id
  return (
    <div>
      <button
        onClick={() => onSelect({ type: 'list', id: list.id })}
        style={{ paddingLeft: 12 + depth * 14 }}
        className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors ${
          isSelected
            ? 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400'
            : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
        }`}
      >
        <span className="truncate">{list.icon ? `${list.icon} ` : '📁 '}{list.name}</span>
      </button>
      {children.map((c) => (
        <ListNode key={c.id} list={c} byParent={byParent} depth={depth + 1} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  )
}

export default function Sidebar({ selected, onSelect }: SidebarProps): React.JSX.Element {
  const listsQuery = useLists()
  const tagsQuery = useTags()
  const lists = (listsQuery.data as KKList[] | undefined) || []
  const tags = (tagsQuery.data as KKTag[] | undefined) || []

  const byParent = useMemo(() => buildTree(lists), [lists])
  const roots = byParent.get(null) || []

  return (
    <div className="flex h-full flex-col overflow-y-auto pb-4 pt-2">
      <div className="px-2">
        <button
          onClick={() => onSelect({ type: 'all' })}
          className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm ${
            selected.type === 'all'
              ? 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400'
              : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
          }`}
        >
          📚 All bookmarks
        </button>
      </div>

      <div className="mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">Lists</div>
      <div className="mt-1 px-2">
        {roots.map((l) => (
          <ListNode key={l.id} list={l} byParent={byParent} depth={0} selected={selected} onSelect={onSelect} />
        ))}
        {listsQuery.isLoading && <div className="px-3 py-1 text-sm text-neutral-400">Loading…</div>}
      </div>

      <div className="mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">Tags</div>
      <div className="mt-1 px-2">
        {tags.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelect({ type: 'tag', id: t.id })}
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
        ))}
        {tagsQuery.isLoading && <div className="px-3 py-1 text-sm text-neutral-400">Loading…</div>}
      </div>
    </div>
  )
}
