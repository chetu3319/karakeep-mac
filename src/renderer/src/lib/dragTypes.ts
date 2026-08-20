/**
 * Shared drag-and-drop plumbing between BookmarkList (drag source) and
 * Sidebar (drop target) for native HTML5 DnD of a bookmark onto a list.
 *
 * `dataTransfer.getData()` is only readable on `drop` (and `dragstart`) in
 * every major browser/Electron's Chromium — during `dragover` you can read
 * `dataTransfer.types` to know a compatible drag is in progress, but not
 * the payload itself. The sidebar needs the payload *during* dragover to
 * decide whether to show "Move" vs "Add" vs "Copy" as the user hovers, so
 * the payload is mirrored into this plain module-level ref on dragstart
 * (single-window desktop app — a module ref is safe here, no cross-tab
 * concerns) and cleared on dragend.
 */
export const BOOKMARK_DRAG_MIME = 'application/x-karakeep-bookmark'

export interface BookmarkDragPayload {
  bookmarkId: string
  sourceType: 'all' | 'list' | 'tag' | 'search'
  sourceId?: string
}

export const currentBookmarkDrag: { current: BookmarkDragPayload | null } = { current: null }
