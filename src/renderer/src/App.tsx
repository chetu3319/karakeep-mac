import React, { useEffect, useRef, useState } from 'react'
import Onboarding from './components/Onboarding'
import Sidebar from './components/Sidebar'
import BookmarkList from './components/BookmarkList'
import DetailPane from './components/DetailPane'
import AddBookmarkDialog from './components/AddBookmarkDialog'
import { useBookmarksList, useLists, flattenBookmarks } from './lib/queries'
import { useCreateFileBookmarks } from './lib/fileBookmarks'
import type { Bookmark, User } from '../../shared/types'
import type { Selection } from './lib/selection'

/** True when a drag is carrying actual files rather than one of our own custom payloads. */
function isFileDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files')
}

type AuthState = { status: 'loading' } | { status: 'onboarding' } | { status: 'ready'; user: User }

// Sidebar/list collapse state is view-only chrome, not user data (unlike
// e.g. listOrder, which lives in main/store.ts because it's real user
// data synced via IPC). We read it synchronously from localStorage at
// first render so the layout is correct on the very first paint — an
// async IPC round-trip to main would mean the panes render expanded and
// then visibly snap closed a frame later on every launch.
const LS_SIDEBAR_COLLAPSED = 'kk:sidebarCollapsed'
const LS_LIST_COLLAPSED = 'kk:listCollapsed'

function readCollapsedFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeCollapsedFlag(key: string, value: boolean): void {
  try {
    if (value) window.localStorage.setItem(key, '1')
    else window.localStorage.removeItem(key)
  } catch {
    // localStorage can throw in some sandboxed contexts; collapse state
    // just won't persist across launches, which is harmless.
  }
}

export default function App(): React.JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [selection, setSelection] = useState<Selection>({ type: 'all' })
  const [selectedBookmark, setSelectedBookmark] = useState<Bookmark | null>(null)
  const [addingBookmark, setAddingBookmark] = useState(false)

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

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readCollapsedFlag(LS_SIDEBAR_COLLAPSED))
  const [listCollapsed, setListCollapsed] = useState(() => readCollapsedFlag(LS_LIST_COLLAPSED))
  // Focus Mode is *derived* from the panes rather than tracked in its own
  // state field. A separate boolean desynced the moment the user collapsed
  // or expanded one pane by hand while in Focus Mode: the flag still said
  // "in", the button rendered as "out", and clicking it then ran the restore
  // branch — so pressing a button that looked like "enter focus mode"
  // expanded everything instead. Deriving it makes that state unreachable.
  // The ref only carries what to restore *to* on exit.
  const priorPanesRef = useRef<{ sidebar: boolean; list: boolean } | null>(null)
  const inFocusMode = sidebarCollapsed && listCollapsed

  useEffect(() => writeCollapsedFlag(LS_SIDEBAR_COLLAPSED, sidebarCollapsed), [sidebarCollapsed])
  useEffect(() => writeCollapsedFlag(LS_LIST_COLLAPSED, listCollapsed), [listCollapsed])

  // Edge case considered: bookmark list collapsed with nothing selected
  // leaves the DetailPane on its empty state. That is NOT a stranded state —
  // the titlebar toggles are rendered in every collapse state, so the list
  // is always one click (or Ctrl+Cmd+L) away.
  //
  // An earlier version auto-expanded the list whenever selectedBookmark went
  // null. That looked like belt-and-braces but broke two things: selection is
  // null on every launch, so it clobbered the persisted collapsed preference
  // (and the write-through effect below then deleted the localStorage key
  // outright), and it made Focus Mode impossible to enter with nothing
  // selected — the list sprang straight back open. No auto-expand here.

  function toggleSidebar(): void {
    setSidebarCollapsed((c) => !c)
  }

  function toggleList(): void {
    setListCollapsed((c) => !c)
  }

  function toggleFocusMode(): void {
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
  }

  useEffect(() => {
    const offSidebar = window.kk.window.onToggleSidebar(toggleSidebar)
    const offList = window.kk.window.onToggleList(toggleList)
    const offFocus = window.kk.window.onToggleFocusMode(toggleFocusMode)
    return () => {
      offSidebar()
      offList()
      offFocus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarCollapsed, listCollapsed])

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
      <Titlebar
        auth={auth}
        onSignOut={() => setAuth({ status: 'onboarding' })}
        onAddBookmark={() => setAddingBookmark(true)}
        sidebarCollapsed={sidebarCollapsed}
        listCollapsed={listCollapsed}
        onToggleSidebar={toggleSidebar}
        onToggleList={toggleList}
        onToggleFocusMode={toggleFocusMode}
      />
      {addingBookmark && <AddBookmarkDialog onClose={() => setAddingBookmark(false)} />}

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
          className={`flex items-start justify-between gap-2 border-b px-3 py-2 text-xs ${
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
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">Loading…</div>
        )}
        {auth.status === 'onboarding' && (
          <Onboarding onSignedIn={(user) => setAuth({ status: 'ready', user })} />
        )}
        {auth.status === 'ready' && (
          <Library
            selection={selection}
            onSelectionChange={(s) => {
              // A sidebar list/tag switch must clear the current selection —
              // otherwise the detail pane (and, worse, the live
              // WebContentsView it drives) keeps showing a bookmark that's
              // no longer even in the filtered list.
              setSelection(s)
              setSelectedBookmark(null)
            }}
            selectedBookmark={selectedBookmark}
            onSelectBookmark={setSelectedBookmark}
            onBookmarkDeleted={(id) =>
              // Only the pane showing the deleted bookmark clears; deleting
              // some other row from its context menu must not blank out
              // whatever the user was reading.
              setSelectedBookmark((current) => (current && current.id === id ? null : current))
            }
            sidebarCollapsed={sidebarCollapsed}
            listCollapsed={listCollapsed}
          />
        )}
      </div>
    </div>
  )
}

function Titlebar({
  auth,
  onSignOut,
  onAddBookmark,
  sidebarCollapsed,
  listCollapsed,
  onToggleSidebar,
  onToggleList,
  onToggleFocusMode
}: {
  auth: AuthState
  onSignOut: () => void
  onAddBookmark: () => void
  sidebarCollapsed: boolean
  listCollapsed: boolean
  onToggleSidebar: () => void
  onToggleList: () => void
  onToggleFocusMode: () => void
}): React.JSX.Element {
  async function signOut(): Promise<void> {
    await window.kk.config.signOut()
    onSignOut()
  }

  return (
    <div className="titlebar-drag flex h-11 flex-shrink-0 items-center justify-between border-b border-neutral-200 bg-neutral-50/80 pl-20 pr-3 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/80">
      <span className="text-sm font-medium text-neutral-600 dark:text-neutral-300">Karakeep</span>
      {auth.status === 'ready' && (
        <div className="titlebar-no-drag flex items-center gap-2">
          {/* Always visible in every collapse state — this is the "way
              back" when both panes are collapsed (e.g. Focus Mode). */}
          <button
            onClick={onToggleSidebar}
            title={sidebarCollapsed ? 'Show Sidebar' : 'Hide Sidebar'}
            aria-pressed={sidebarCollapsed}
            className={`rounded px-1.5 py-1 text-xs ${
              sidebarCollapsed
                ? 'bg-neutral-200/70 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200'
                : 'text-neutral-400 hover:bg-neutral-200/60 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
            }`}
          >
            ▥
          </button>
          <button
            onClick={onToggleList}
            title={listCollapsed ? 'Show Bookmark List' : 'Hide Bookmark List'}
            aria-pressed={listCollapsed}
            className={`rounded px-1.5 py-1 text-xs ${
              listCollapsed
                ? 'bg-neutral-200/70 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200'
                : 'text-neutral-400 hover:bg-neutral-200/60 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
            }`}
          >
            ☰
          </button>
          <button
            onClick={onToggleFocusMode}
            title="Focus Mode"
            aria-pressed={sidebarCollapsed && listCollapsed}
            className={`rounded px-1.5 py-1 text-xs ${
              sidebarCollapsed && listCollapsed
                ? 'bg-neutral-200/70 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200'
                : 'text-neutral-400 hover:bg-neutral-200/60 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
            }`}
          >
            ⛶
          </button>
          <span className="mx-1 h-4 w-px bg-neutral-300 dark:bg-neutral-700" aria-hidden />
          <button
            onClick={onAddBookmark}
            className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700"
          >
            + Add bookmark
          </button>
          <span className="text-xs text-neutral-500">{auth.user.email || auth.user.name}</span>
          <button
            onClick={signOut}
            className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-200/60 dark:hover:bg-neutral-800"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

function Library({
  selection,
  onSelectionChange,
  selectedBookmark,
  onSelectBookmark,
  onBookmarkDeleted,
  sidebarCollapsed,
  listCollapsed
}: {
  selection: Selection
  onSelectionChange: (s: Selection) => void
  selectedBookmark: Bookmark | null
  onSelectBookmark: (b: Bookmark) => void
  onBookmarkDeleted: (id: string) => void
  sidebarCollapsed: boolean
  listCollapsed: boolean
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

  // Grid template is driven from state via inline style (Tailwind's static
  // classes can't express a runtime-computed column list). Collapsed columns
  // go to 0px with no transition — the DetailPane's Web tab is a native
  // WebContentsView positioned by main from the container div's rect
  // (see WebPane.tsx), and a CSS width/transform transition here would make
  // that native content visibly tear away from its frame while animating.
  // Snapping instantly keeps the frame in lockstep at every point in time.
  const gridTemplateColumns = `${sidebarCollapsed ? '0px' : '220px'} ${listCollapsed ? '0px' : '360px'} minmax(0,1fr)`

  return (
    <div className="grid h-full grid-rows-[minmax(0,1fr)]" style={{ gridTemplateColumns }}>
      {/* Collapsed panes are unmounted entirely (not just hidden) so a
          zero-width Sidebar/BookmarkList can't still capture tab focus or
          act as a drop target, and so re-expanding always mounts a fresh
          component instance with no stale drag state or detached
          listeners left over from before the collapse. */}
      <div className="min-w-0 overflow-hidden">
        {!sidebarCollapsed && <Sidebar selected={selection} onSelect={onSelectionChange} />}
      </div>
      <div className="min-w-0 overflow-hidden">
        {!listCollapsed && (
          <BookmarkList
            selection={selection}
            selectedId={selectedBookmark?.id ?? null}
            onSelectBookmark={onSelectBookmark}
            onBookmarkDeleted={onBookmarkDeleted}
          />
        )}
      </div>
      <DetailPane bookmark={selectedBookmark} onDeleted={onBookmarkDeleted} />
    </div>
  )
}
