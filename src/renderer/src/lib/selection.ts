import type { BookmarkListFilter } from '../../../shared/types'

/**
 * What the sidebar is currently pointed at. Lived as three separate
 * copy-pasted unions (App, BookmarkList, Sidebar) until 'favourites' and
 * 'archived' needed adding to all three at once.
 *
 * 'all', 'favourites' and 'archived' are all served by GET /bookmarks with
 * different query filters; 'list' and 'tag' have their own endpoints.
 */
export type Selection =
  | { type: 'all' }
  | { type: 'favourites' }
  | { type: 'archived' }
  | { type: 'list'; id: string }
  | { type: 'tag'; id: string }

/** True for the selections served by the paginated GET /bookmarks feed. */
export function isFeedSelection(selection: Selection): boolean {
  return selection.type === 'all' || selection.type === 'favourites' || selection.type === 'archived'
}

/**
 * Server-side filter for a feed selection.
 *
 * 'all' pins `archived: false` rather than sending nothing: verified live,
 * an unfiltered GET /bookmarks returns archived rows mixed in with the
 * rest, so without this an archived bookmark would still sit in the main
 * list and archiving would look like it had done nothing.
 *
 * 'favourites' likewise excludes archived ones, so a bookmark that has been
 * both starred and filed away doesn't show up in two places at once —
 * Archive is the more specific state, and it wins.
 */
export function filterForSelection(selection: Selection): BookmarkListFilter {
  switch (selection.type) {
    case 'favourites':
      return { favourited: true, archived: false }
    case 'archived':
      return { archived: true }
    default:
      return { archived: false }
  }
}
