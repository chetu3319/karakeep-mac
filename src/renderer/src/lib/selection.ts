import type { BookmarkListFilter } from '../../../shared/types'

/**
 * What the sidebar is currently pointed at. Lived as three separate
 * copy-pasted unions (App, BookmarkList, Sidebar) until 'favourites' and
 * 'archived' needed adding to all three at once.
 *
 * 'all', 'favourites' and 'archived' are all served by GET /bookmarks with
 * different query filters; 'list' and 'tag' have their own endpoints.
 *
 * 'highlights' is the odd one out: it isn't a bookmark feed at all. It
 * selects the global highlight stream, optionally narrowed to a set of
 * colours, and the middle pane renders HighlightsList instead of
 * BookmarkList for it. Colours live in the selection rather than in
 * component state so the filter survives navigating away and back, and so
 * the whole "what am I looking at" question still has exactly one answer.
 */
export type Selection =
  | { type: 'all' }
  | { type: 'favourites' }
  | { type: 'archived' }
  | { type: 'list'; id: string }
  | { type: 'tag'; id: string }
  | { type: 'highlights'; colors: string[] }

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

/**
 * Human name for the current scope, used by the search-scope chip and the
 * list header. `resolveName` looks up a list/tag id — the caller has those
 * queries, this module deliberately doesn't.
 */
export function selectionLabel(selection: Selection, resolveName: (sel: Selection) => string | undefined): string {
  switch (selection.type) {
    case 'all':
      return 'All bookmarks'
    case 'favourites':
      return 'Favourites'
    case 'archived':
      return 'Archive'
    case 'highlights':
      return 'Highlights'
    case 'list':
      return resolveName(selection) ?? 'List'
    case 'tag':
      return resolveName(selection) ? `#${resolveName(selection)}` : 'Tag'
  }
}

/**
 * Round-trip a selection through localStorage so a relaunch reopens where
 * the user left off instead of snapping back to "All bookmarks".
 *
 * Parsing is total: an id that no longer exists server-side, or a shape
 * written by an older build, degrades to `{type:'all'}` rather than
 * throwing at startup or leaving the app pointed at a list that 404s.
 */
export function parseSelection(raw: unknown): Selection {
  if (!raw || typeof raw !== 'object') return { type: 'all' }
  const value = raw as { type?: unknown; id?: unknown; colors?: unknown }
  switch (value.type) {
    case 'all':
    case 'favourites':
    case 'archived':
      return { type: value.type }
    case 'list':
    case 'tag':
      return typeof value.id === 'string' ? { type: value.type, id: value.id } : { type: 'all' }
    case 'highlights':
      return {
        type: 'highlights',
        colors: Array.isArray(value.colors) ? value.colors.filter((c): c is string => typeof c === 'string') : []
      }
    default:
      return { type: 'all' }
  }
}
