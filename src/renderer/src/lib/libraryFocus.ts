/**
 * Window event meaning "focus the bookmark list's search box". ⌘F with no
 * document open lands here (routed by DetailPane), and so does the menu's
 * explicit Find in Library — BookmarkList listens for both.
 */
export const FOCUS_LIBRARY_SEARCH = 'kk:focus-library-search'
