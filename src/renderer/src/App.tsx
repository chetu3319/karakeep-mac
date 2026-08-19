import React, { useEffect, useRef, useState } from 'react'
import Onboarding from './components/Onboarding'
import Sidebar from './components/Sidebar'
import BookmarkList from './components/BookmarkList'
import DetailPane from './components/DetailPane'
import { useBookmarksList, useLists, flattenBookmarks } from './lib/queries'
import type { Bookmark, User } from '../../shared/types'

type AuthState = { status: 'loading' } | { status: 'onboarding' } | { status: 'ready'; user: User }
type Selection = { type: 'all' } | { type: 'list'; id: string } | { type: 'tag'; id: string }

export default function App(): React.JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' })
  const [selection, setSelection] = useState<Selection>({ type: 'all' })
  const [selectedBookmark, setSelectedBookmark] = useState<Bookmark | null>(null)

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
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-white dark:bg-neutral-950">
      <Titlebar auth={auth} onSignOut={() => setAuth({ status: 'onboarding' })} />
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
            onSelectionChange={setSelection}
            selectedBookmark={selectedBookmark}
            onSelectBookmark={setSelectedBookmark}
          />
        )}
      </div>
    </div>
  )
}

function Titlebar({ auth, onSignOut }: { auth: AuthState; onSignOut: () => void }): React.JSX.Element {
  async function signOut(): Promise<void> {
    await window.kk.config.signOut()
    onSignOut()
  }

  return (
    <div className="titlebar-drag flex h-11 flex-shrink-0 items-center justify-between border-b border-neutral-200 bg-neutral-50/80 pl-20 pr-3 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/80">
      <span className="text-sm font-medium text-neutral-600 dark:text-neutral-300">Karakeep</span>
      {auth.status === 'ready' && (
        <div className="titlebar-no-drag flex items-center gap-2">
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
  onSelectBookmark
}: {
  selection: Selection
  onSelectionChange: (s: Selection) => void
  selectedBookmark: Bookmark | null
  onSelectBookmark: (b: Bookmark) => void
}): React.JSX.Element {
  // Also used to drive the dev smoke script's auto bookmark selection.
  const listQuery = useBookmarksList()
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

  useEffect(() => {
    if (smokeStarted && !selectedBookmark && bookmarks.length > 0) {
      onSelectBookmark(bookmarks[0])
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

  return (
    <div className="grid h-full grid-cols-[220px_360px_1fr]">
      <Sidebar selected={selection} onSelect={onSelectionChange} />
      <BookmarkList selection={selection} selectedId={selectedBookmark?.id ?? null} onSelectBookmark={onSelectBookmark} />
      <DetailPane bookmark={selectedBookmark} />
    </div>
  )
}
