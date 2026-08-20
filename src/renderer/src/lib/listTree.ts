import type { KKList, ListOrder } from '../../../shared/types'

/**
 * Pure helpers for the sidebar's list tree: parent-key normalization,
 * cycle detection for drag-to-nest, and sibling ordering. Kept separate
 * from Sidebar.tsx so the drag/drop math can be reasoned about (and, if it
 * ever needs it, tested) without the component's event-handling noise.
 */

/** The key used in ListOrder / grouping maps for a list's parent — 'root' for top-level. */
export function parentKey(list: Pick<KKList, 'parentId'>): string {
  return list.parentId ?? 'root'
}

export function buildByParent(lists: KKList[]): Map<string, KKList[]> {
  const byParent = new Map<string, KKList[]>()
  for (const l of lists) {
    const key = parentKey(l)
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(l)
  }
  return byParent
}

/**
 * All descendant ids of `id` (children, grandchildren, ...). Used to block
 * a list from being dropped onto itself or into its own subtree, which
 * would otherwise create a cycle the sidebar tree can't render.
 */
export function descendantIds(byParent: Map<string, KKList[]>, id: string): Set<string> {
  const result = new Set<string>()
  const stack = [id]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const child of byParent.get(current) || []) {
      if (!result.has(child.id)) {
        result.add(child.id)
        stack.push(child.id)
      }
    }
  }
  return result
}

/** True if `targetId` is `draggedId` itself or one of its descendants — an invalid drop. */
export function wouldCycle(byParent: Map<string, KKList[]>, draggedId: string, targetId: string): boolean {
  if (draggedId === targetId) return true
  return descendantIds(byParent, draggedId).has(targetId)
}

/**
 * Sorts a parent's children: ids present in the stored order array come
 * first (in that order), everything else follows alphabetically. Lists the
 * user has never reordered are simply not in the array yet.
 */
export function orderedChildren(children: KKList[], orderArr: string[] | undefined): KKList[] {
  const order = orderArr || []
  const rank = new Map(order.map((id, i) => [id, i]))
  const known = children.filter((c) => rank.has(c.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  const unknown = children.filter((c) => !rank.has(c.id)).sort((a, b) => a.name.localeCompare(b.name))
  return [...known, ...unknown]
}

/**
 * Computes the new ListOrder after moving `draggedId` to be a sibling of
 * `targetId` (before/after it) within whatever parent `targetId` lives
 * under. Returns the full updated order map plus the parentId the dragged
 * list must be PATCHed to if it changed parents.
 */
export function reorderAsSibling(
  lists: KKList[],
  order: ListOrder,
  draggedId: string,
  targetId: string,
  position: 'before' | 'after'
): { order: ListOrder; newParentId: string | null } {
  const byParent = buildByParent(lists)
  const target = lists.find((l) => l.id === targetId)
  if (!target) return { order, newParentId: null }
  const newParentKey = parentKey(target)
  const oldList = lists.find((l) => l.id === draggedId)
  const oldParentKey = oldList ? parentKey(oldList) : newParentKey

  const siblings = orderedChildren(byParent.get(newParentKey) || [], order[newParentKey]).map((l) => l.id)
  const withoutDragged = siblings.filter((id) => id !== draggedId)
  const targetIdx = withoutDragged.indexOf(targetId)
  const insertAt = position === 'before' ? targetIdx : targetIdx + 1
  const newSiblingOrder = [...withoutDragged.slice(0, insertAt), draggedId, ...withoutDragged.slice(insertAt)]

  const nextOrder: ListOrder = { ...order, [newParentKey]: newSiblingOrder }
  if (oldParentKey !== newParentKey) {
    nextOrder[oldParentKey] = (order[oldParentKey] || []).filter((id) => id !== draggedId)
  }

  return { order: nextOrder, newParentId: target.parentId ?? null }
}

/** Computes the new ListOrder after nesting `draggedId` as the last child of `targetId`. */
export function nestUnder(
  lists: KKList[],
  order: ListOrder,
  draggedId: string,
  targetId: string
): { order: ListOrder; newParentId: string } {
  const oldList = lists.find((l) => l.id === draggedId)
  const oldParentKey = oldList ? parentKey(oldList) : 'root'
  const existing = (order[targetId] || []).filter((id) => id !== draggedId)
  const nextOrder: ListOrder = { ...order, [targetId]: [...existing, draggedId] }
  if (oldParentKey !== targetId) {
    nextOrder[oldParentKey] = (order[oldParentKey] || []).filter((id) => id !== draggedId)
  }
  return { order: nextOrder, newParentId: targetId }
}

/** Computes the new ListOrder after moving `draggedId` to the top level (root), appended last. */
export function moveToRoot(lists: KKList[], order: ListOrder, draggedId: string): { order: ListOrder } {
  const oldList = lists.find((l) => l.id === draggedId)
  const oldParentKey = oldList ? parentKey(oldList) : 'root'
  const existing = (order['root'] || []).filter((id) => id !== draggedId)
  const nextOrder: ListOrder = { ...order, root: [...existing, draggedId] }
  if (oldParentKey !== 'root') {
    nextOrder[oldParentKey] = (order[oldParentKey] || []).filter((id) => id !== draggedId)
  }
  return { order: nextOrder }
}
