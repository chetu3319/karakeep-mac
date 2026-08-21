import React, { useCallback, useEffect, useRef, useState } from 'react'
import Onboarding from './components/Onboarding'
import Sidebar from './components/Sidebar'
import BookmarkList from './components/BookmarkList'
import HighlightsList from './components/HighlightsList'
import DetailPane from './components/DetailPane'
import AddBookmarkDialog from './components/AddBookmarkDialog'
import SettingsDialog from './components/SettingsDialog'
import ConfirmDialog from './components/ConfirmDialog'
import TitlebarRow from './components/TitlebarRow'
import { useBookmarksList, useLists, flattenBookmarks } from './lib/queries'
import { useCreateFileBookmarks } from './lib/fileBookmarks'
import { readPref, usePref, writePref } from './lib/prefs'
import { parseSelection, type Selection } from './lib/selection'
import type { Bookmark, User } from '../../shared/types'

/** True when a drag is carrying actual files rather than one of our own custom payloads. */
function isFileDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files')
}

type AuthState = { status: 'loading' } | { status: 'onboarding' } | { status: 'ready'; user: User }

const PANE_LIMITS = { sidebar: { min: 180, max: 380 }, list: { min: 260, max: 560 } }
const DEFAULT_WIDTHS = { sidebar: 230, list: 360 }

export default function App(): React.JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  // Reopen where the user left off. An id that has since been deleted
  // server-side just yields an empty list pane, which is self-explanatory
  // and one sidebar click away from fixed — better than always dumping
  // everyone back at "All bookmarks".
  const [selection, setSelection] = useState<Selection>(() => parseSelection(readPref('selection', null)))
  const [selectedBookmark, setSelectedBookmark] = useState<Bookmark | null>(null)
  const [focusHighlightId, setFocusHighlightId] = useState<string | null>(null)
  const [addingBookmark, setAddingBookmark] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)

  useEffect(() => writePref('selection', selection), [selection])

  // ── Drop files onto the window to file them ──
  const createFileBookmarks = useCreateFileBookmarks()
  const [fileDragActive, setFileDragActive] = useState(false)
  const [importStatus, setImportStatus] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  // dragenter/dragleave fire on every child element the pointer crosses, so
  // a plain boolean flickers the overlay off the moment the cursor moves
  // from one pane to the next. Counting enters against leaves is the
  // standard fix.
  const dragDepthRef = useRef(0)

  const canDropFiles = auth.status === 'ready'

  // Electron navigates the whole window to a dropped file unless the
  // default is cancelled, which would replace the app with a PDF viewer and
  // no way back. This catches drops that miss the handled region (the
  // titlebar, say) — the root div's own handlers cover the rest.
  useEffect(() => {
    function swallow(e: DragEvent): void {
      if (isFileDrag(e.dataTransfer)) e.preventDefault()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  async function handleFileDrop(files: File[]): Promise<void> {
    if (files.length === 0) return
    setImportError(null)
    setImportStatus(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`)
    // Dropping while a list is selected files the import into that list —
    // the same thing dragging a bookmark onto a list already does.
    const listId = selection.type === 'list' ? selection.id : undefined
    const result = await createFileBookmarks(files, { listId })
    setImportStatus(null)
    if (result.failed.length > 0) {
      setImportError(result.failed.map((f) => `${f.fileName}: ${f.message}`).join('\n'))
    }
    // Select the first import so it's immediately visible — a drop that
    // changes nothing on screen reads as a drop that didn't work.
    if (result.created.length > 0) setSelectedBookmark(result.created[0])
  }

  const [sidebarCollapsed, setSidebarCollapsed] = usePref('sidebarCollapsed', false)
  const [listCollapsed, setListCollapsed] = usePref('listCollapsed', false)
  const [sidebarWidth, setSidebarWidth] = usePref('sidebarWidth', DEFAULT_WIDTHS.sidebar)
  const [listWidth, setListWidth] = usePref('listWidth', DEFAULT_WIDTHS.list)

  // Focus Mode is *derived* from the panes rather than tracked in its own
  // state field. A separate boolean desynced the moment the user collapsed
  // or expanded one pane by hand while in Focus Mode: the flag still said
  // "in", the button rendered as "out", and clicking it then ran the restore
  // branch — so pressing a button that looked like "enter focus mode"
  // expanded everything instead. Deriving it makes that state unreachable.
  // The ref only carries what to restore *to* on exit.
  const priorPanesRef = useRef<{ sidebar: boolean; list: boolean } | null>(null)
  const inFocusMode = sidebarCollapsed && listCollapsed

  // Edge case considered: bookmark list collapsed with nothing selected
  // leaves the DetailPane on its empty state. That is NOT a stranded
  // state — both pane toggles are on screen at a fixed position in every
  // combination (see TitlebarRow), plus ⌃⌘S / ⌃⌘L / ⌃⌘F.

  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), [setSidebarCollapsed])
  const toggleList = useCallback(() => setListCollapsed((c) => !c), [setListCollapsed])

  const toggleFocusMode = useCallback(() => {
    if (!inFocusMode) {
      priorPanesRef.current = { sidebar: sidebarCollapsed, list: listCollapsed }
      setSidebarCollapsed(true)
      setListCollapsed(true)
      return
    }
    // Exiting. If both panes were already collapsed before Focus Mode was
    // entered, restoring "what the user had" would be a no-op that looks
    // broken — fall back to expanding both so the toggle always visibly does
    // something.
    const prior = priorPanesRef.current
    const restore = prior && !(prior.sidebar && prior.list) ? prior : { sidebar: false, list: false }
    setSidebarCollapsed(restore.sidebar)
    setListCollapsed(restore.list)
    priorPanesRef.current = null
  }, [inFocusMode, sidebarCollapsed, listCollapsed, setSidebarCollapsed, setListCollapsed])

  useEffect(() => {
    const offs = [
      window.kk.window.onToggleSidebar(toggleSidebar),
      window.kk.window.onToggleList(toggleList),
      window.kk.window.onToggleFocusMode(toggleFocusMode),
      window.kk.window.onNewBookmark(() => setAddingBookmark(true)),
      window.kk.window.onOpenSettings(() => setSettingsOpen(true))
    ]
    return () => offs.forEach((off) => off())
  }, [toggleSidebar, toggleList, toggleFocusMode])

  useEffect(() => {
    let cancelled = false
    window.kk.config.get().then(async (cfg) => {
      if (!cfg.hasApiKey) {
        if (!cancelled) setAuth({ status: 'onboarding' })
        return
      }
      const result = await window.kk.auth.test()
      if (cancelled) return
      if (result.ok && result.user) setAuth({ status: 'ready', user: result.user })
      else setAuth({ status: 'onboarding' })
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function signOut(): Promise<void> {
    setConfirmSignOut(false)
    setSettingsOpen(false)
    await window.kk.config.signOut()
    setAuth({ status: 'onboarding' })
  }

  function changeSelection(next: Selection): void {
    // A sidebar list/tag switch must clear the current bookmark —
    // otherwise the detail pane (and, worse, the live WebContentsView it
    // drives) keeps showing a bookmark that's no longer even in the
    // filtered list.
    setSelection(next)
    setSelectedBookmark(null)
    setFocusHighlightId(null)
  }

  return (
    <div
      className="relative flex h-screen w-screen flex-col overflow-hidden bg-white dark:bg-neutral-950"
      onDragEnter={(e) => {
        if (!canDropFiles || !isFileDrag(e.dataTransfer)) return
        dragDepthRef.current += 1
        setFileDragActive(true)
      }}
      onDragOver={(e) => {
        if (!canDropFiles || !isFileDrag(e.dataTransfer)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!canDropFiles || !isFileDrag(e.dataTransfer)) return
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) setFileDragActive(false)
      }}
      onDrop={(e) => {
        if (!canDropFiles || !isFileDrag(e.dataTransfer)) return
        e.preventDefault()
        dragDepthRef.current = 0
        setFileDragActive(false)
        void handleFileDrop(Array.from(e.dataTransfer.files))
      }}
    >
      {addingBookmark && <AddBookmarkDialog onClose={() => setAddingBookmark(false)} />}
      {settingsOpen && auth.status === 'ready' && (
        <SettingsDialog
          user={auth.user}
          onClose={() => setSettingsOpen(false)}
          onSignOut={() => setConfirmSignOut(true)}
          onReauthenticated={(user) => setAuth({ status: 'ready', user })}
        />
      )}
      {confirmSignOut && (
        <ConfirmDialog
          title="Sign out of Karakeep?"
          description="Your API key is removed from this Mac's Keychain and you'll need to paste it again to sign back in. Your bookmarks, lists and sidebar arrangement stay exactly as they are."
          confirmLabel="Sign out"
          onConfirm={() => void signOut()}
          onCancel={() => setConfirmSignOut(false)}
        />
      )}

      {fileDragActive && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-emerald-600/10 backdrop-blur-[1px]">
          <div className="rounded-2xl border-2 border-dashed border-emerald-500 bg-white/90 px-8 py-6 text-center shadow-lg dark:bg-neutral-900/90">
            <div className="text-2xl">📥</div>
            <div className="mt-1 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              Drop to add to Karakeep
            </div>
            <div className="mt-0.5 text-xs text-neutral-500">
              {selection.type === 'list' ? 'Files land in the selected list' : 'PDFs and images'}
            </div>
          </div>
        </div>
      )}

      {(importStatus || importError) && (
        <div
          className={`z-30 flex items-start justify-between gap-2 border-b px-3 py-2 text-xs ${
            importError
              ? 'border-red-100 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400'
              : 'border-emerald-100 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
          }`}
        >
          <span className="whitespace-pre-wrap">{importError || importStatus}</span>
          {importError && (
            <button onClick={() => setImportError(null)} className="flex-shrink-0 font-medium hover:underline">
              Dismiss
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {auth.status === 'loading' && (
          <div className="titlebar-drag flex h-full items-center justify-center text-sm text-neutral-400">
            Loading…
          </div>
        )}
        {auth.status === 'onboarding' && (
          <Onboarding onSignedIn={(user) => setAuth({ status: 'ready', user })} />
        )}
        {auth.status === 'ready' && (
          <Library
            user={auth.user}
            selection={selection}
            onSelectionChange={changeSelection}
            selectedBookmark={selectedBookmark}
            onSelectBookmark={(b) => {
              setSelectedBookmark(b)
              setFocusHighlightId(null)
            }}
            focusHighlightId={focusHighlightId}
            onOpenHighlight={(b, highlightId) => {
              setSelectedBookmark(b)
              setFocusHighlightId(highlightId)
            }}
            onFocusHighlightHandled={() => setFocusHighlightId(null)}
            onBookmarkDeleted={(id) =>
              // Only the pane showing the deleted bookmark clears; deleting
              // some other row from its context menu must not blank out
              // whatever the user was reading.
              setSelectedBookmark((current) => (current && current.id === id ? null : current))
            }
            onAddBookmark={() => setAddingBookmark(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onSignOut={() => setConfirmSignOut(true)}
            sidebarCollapsed={sidebarCollapsed}
            listCollapsed={listCollapsed}
            onToggleSidebar={toggleSidebar}
            onToggleList={toggleList}
            sidebarWidth={sidebarWidth}
            listWidth={listWidth}
            onSidebarWidth={setSidebarWidth}
            onListWidth={setListWidth}
          />
        )}
      </div>
    </div>
  )
}

/**
 * Draggable divider between two panes.
 *
 * Pointer capture rather than window-level mousemove listeners: capture
 * keeps receiving events when the pointer leaves the 5px handle (which it
 * does immediately on any real drag) and it releases cleanly if the drag
 * ends outside the window.
 *
 * The width is committed on every move rather than at the end. That does
 * mean the native WebContentsView in the Web tab is repositioned
 * continuously while dragging — but it is repositioned *in lockstep* with
 * its container, which is the property that matters. Committing only on
 * release would leave the pane's frame and its native content visibly
 * disagreeing for the whole drag.
 */
function Resizer({
  ariaLabel,
  width,
  min,
  max,
  defaultWidth,
  onWidth
}: {
  ariaLabel: string
  width: number
  min: number
  max: number
  /** Double-clicking the divider returns the pane to this width. */
  defaultWidth: number
  onWidth: (next: number) => void
}): React.JSX.Element {
  const startRef = useRef<{ x: number; width: number } | null>(null)

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        startRef.current = { x: e.clientX, width }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const start = startRef.current
        if (!start) return
        onWidth(Math.min(max, Math.max(min, start.width + (e.clientX - start.x))))
      }}
      onPointerUp={(e) => {
        startRef.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
      }}
      onDoubleClick={() => onWidth(defaultWidth)}
      onKeyDown={(e) => {
        // A divider you can only move with a mouse is a divider some
        // people simply cannot move.
        if (e.key === 'ArrowLeft') {
          e.preventDefault()
          onWidth(Math.max(min, width - (e.shiftKey ? 40 : 8)))
        } else if (e.key === 'ArrowRight') {
          e.preventDefault()
          onWidth(Math.min(max, width + (e.shiftKey ? 40 : 8)))
        }
      }}
      className="group relative z-10 -mr-[3px] w-[6px] flex-shrink-0 cursor-col-resize touch-none focus-visible:outline-none"
    >
      <span className="absolute inset-y-0 left-[2px] w-[2px] bg-transparent transition-colors group-hover:bg-emerald-500/60 group-focus-visible:bg-emerald-500" />
    </div>
  )
}

function Library({
  user,
  selection,
  onSelectionChange,
  selectedBookmark,
  onSelectBookmark,
  focusHighlightId,
  onOpenHighlight,
  onFocusHighlightHandled,
  onBookmarkDeleted,
  onAddBookmark,
  onOpenSettings,
  onSignOut,
  sidebarCollapsed,
  listCollapsed,
  onToggleSidebar,
  onToggleList,
  sidebarWidth,
  listWidth,
  onSidebarWidth,
  onListWidth
}: {
  user: User
  selection: Selection
  onSelectionChange: (s: Selection) => void
  selectedBookmark: Bookmark | null
  onSelectBookmark: (b: Bookmark) => void
  focusHighlightId: string | null
  onOpenHighlight: (b: Bookmark, highlightId: string) => void
  onFocusHighlightHandled: () => void
  onBookmarkDeleted: (id: string) => void
  onAddBookmark: () => void
  onOpenSettings: () => void
  onSignOut: () => void
  sidebarCollapsed: boolean
  listCollapsed: boolean
  onToggleSidebar: () => void
  onToggleList: () => void
  sidebarWidth: number
  listWidth: number
  onSidebarWidth: (n: number) => void
  onListWidth: (n: number) => void
}): React.JSX.Element {
  // Smoke-run scaffolding only: the real list lives in BookmarkList, which
  // runs its own filtered query. Gating this on the smoke flag keeps normal
  // launches from issuing a second, differently-filtered GET /bookmarks
  // whose results nothing renders.
  const listQuery = useBookmarksList(window.kk.dev.isSmoke)
  const bookmarks = flattenBookmarks(listQuery.data?.pages)
  const listsQuery = useLists()
  const lists = listsQuery.data || []
  const [smokeStarted, setSmokeStarted] = useState(false)

  useEffect(() => {
    if (!window.kk.dev.isSmoke) return
    // Wait for main's explicit go-ahead (sent right after it captures the
    // "library, nothing selected" screenshot) before auto-selecting a
    // bookmark — otherwise selection can race ahead of that first shot.
    window.kk.dev.onSmokeStart(() => setSmokeStarted(true))
  }, [])

  // One-shot: only auto-select at smoke-test startup. Without this guard,
  // the effect would re-fire (and re-select bookmarks[0] from the
  // unfiltered "all" list) every time selectedBookmark goes back to null —
  // which is exactly what the list-switch fix now does on purpose, and
  // that re-selection would silently mask the very bug it's meant to prove
  // fixed in the step-4 screenshot.
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    // KK_SMOKE_BOOKMARK pins the run to one bookmark (the PDF smoke needs a
    // PDF, and bookmarks[0] is whatever was saved most recently). A pinned
    // run selects as soon as the list arrives rather than waiting for main's
    // go-ahead: that event is fired on a timer and can land before the
    // renderer has mounted and subscribed, which silently strands the run.
    const pinned = window.kk.dev.smokeBookmarkId
    const pinnedBookmark = pinned ? bookmarks.find((b) => b.id === pinned) : undefined
    if ((smokeStarted || pinnedBookmark) && !autoSelectedRef.current && !selectedBookmark && bookmarks.length > 0) {
      autoSelectedRef.current = true
      onSelectBookmark(pinnedBookmark || bookmarks[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smokeStarted, bookmarks.length, selectedBookmark])

  const listsRef = useRef(lists)
  listsRef.current = lists

  useEffect(() => {
    if (!window.kk.dev.isSmoke) return
    // Registered once; reads the latest lists via a ref so it doesn't need
    // to re-subscribe (and leak listeners) every time the lists query updates.
    window.kk.dev.onSelectList(() => {
      const current = listsRef.current
      if (current.length > 0) onSelectionChange({ type: 'list', id: current[0].id })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The title area belongs to whichever column is leftmost; with the
  // sidebar showing, that is the sidebar and it renders this itself. Same
  // component, same inset, so the toggles land on the same pixels either
  // way and hiding a pane never moves the control that brings it back.
  const titlebar = (
    <TitlebarRow
      sidebarCollapsed={sidebarCollapsed}
      listCollapsed={listCollapsed}
      onToggleSidebar={onToggleSidebar}
      onToggleList={onToggleList}
    />
  )

  return (
    <div className="flex h-full">
      {/* Collapsed panes are unmounted entirely (not just hidden) so a
          zero-width Sidebar/BookmarkList can't still capture tab focus or
          act as a drop target, and so re-expanding always mounts a fresh
          component instance with no stale drag state or detached
          listeners left over from before the collapse. */}
      {!sidebarCollapsed && (
        <>
          <div className="min-w-0 flex-shrink-0" style={{ width: sidebarWidth }}>
            <Sidebar
              selected={selection}
              onSelect={onSelectionChange}
              user={user}
              onAddBookmark={onAddBookmark}
              onOpenSettings={onOpenSettings}
              onSignOut={onSignOut}
              listCollapsed={listCollapsed}
              onToggleSidebar={onToggleSidebar}
              onToggleList={onToggleList}
            />
          </div>
          <Resizer
            ariaLabel="Resize sidebar"
            width={sidebarWidth}
            min={PANE_LIMITS.sidebar.min}
            max={PANE_LIMITS.sidebar.max}
            defaultWidth={DEFAULT_WIDTHS.sidebar}
            onWidth={onSidebarWidth}
          />
        </>
      )}

      {!listCollapsed && (
        <>
          <div className="flex min-w-0 flex-shrink-0 flex-col" style={{ width: listWidth }}>
            {sidebarCollapsed && titlebar}
            <div className="min-h-0 flex-1">
              {selection.type === 'highlights' ? (
                <HighlightsList
                  colors={selection.colors}
                  selectedId={focusHighlightId}
                  onOpenHighlight={onOpenHighlight}
                />
              ) : (
                <BookmarkList
                  selection={selection}
                  selectedId={selectedBookmark?.id ?? null}
                  onSelectBookmark={onSelectBookmark}
                  onBookmarkDeleted={onBookmarkDeleted}
                />
              )}
            </div>
          </div>
          <Resizer
            ariaLabel="Resize bookmark list"
            width={listWidth}
            min={PANE_LIMITS.list.min}
            max={PANE_LIMITS.list.max}
            defaultWidth={DEFAULT_WIDTHS.list}
            onWidth={onListWidth}
          />
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {sidebarCollapsed && listCollapsed && titlebar}
        <div className="min-h-0 flex-1">
          <DetailPane
            bookmark={selectedBookmark}
            onDeleted={onBookmarkDeleted}
            focusHighlightId={focusHighlightId}
            onFocusHighlightHandled={onFocusHighlightHandled}
            listCollapsed={listCollapsed}
            onExpandList={onToggleList}
          />
        </div>
      </div>
    </div>
  )
}
