import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { hexForColor as colorFor } from '../../../shared/highlightUi'
import type { Bookmark, Highlight, UpdateBookmarkInput, WebPaneState } from '../../../shared/types'
import { useBookmark, useDeleteBookmark, useHighlightsForBookmark, useUpdateBookmark } from '../lib/queries'
import { displayForBookmark } from '../lib/bookmarkDisplay'
import { usePref } from '../lib/prefs'
import { errMessage } from '../lib/errors'
import AssetImage from './AssetImage'
import ConfirmDialog from './ConfirmDialog'
import EditableField from './EditableField'
import Icon from './Icon'
import ListMembership from './ListMembership'
import PdfPane from './PdfPane'
import TagEditor from './TagEditor'
import WebPane from './WebPane'

type Tab = 'preview' | 'pdf' | 'web'

const EMPTY_WEB_STATE: WebPaneState = {
  url: '',
  title: '',
  isLoading: true,
  canGoBack: false,
  canGoForward: false,
  error: null
}

export default function DetailPane({
  bookmark: selected,
  onDeleted,
  focusHighlightId: externalFocusHighlightId,
  onFocusHighlightHandled,
  listCollapsed,
  onExpandList
}: {
  bookmark: Bookmark | null
  onDeleted: (id: string) => void
  /** Set when a highlight was opened from the sidebar's Highlights view. */
  focusHighlightId?: string | null
  onFocusHighlightHandled?: () => void
  listCollapsed: boolean
  onExpandList: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('preview')
  // The row object the list handed us is a snapshot from whenever that feed
  // was last fetched. Now that this pane can edit the bookmark, read through
  // a live per-bookmark query and fall back to the snapshot only until the
  // first fetch lands — otherwise every edit made here would keep rendering
  // its own pre-edit state.
  const live = useBookmark(selected?.id)
  const bookmark = live.data ?? selected
  const highlights = useHighlightsForBookmark(bookmark?.id)
  const queryClient = useQueryClient()
  const updateBookmark = useUpdateBookmark()
  const deleteBookmark = useDeleteBookmark()
  const [pendingDelete, setPendingDelete] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // Highlights used to live only inside the Preview tab's scroll body, so
  // switching to the Web or PDF pane — the only place a highlight can
  // actually be *looked at* — took the list you were navigating from off
  // screen. As a rail it stays put across tabs. Persisted, because whether
  // you work with highlights open is a habit, not a per-bookmark decision.
  const [railOpen, setRailOpen] = usePref('highlightRailOpen', false)

  // Navigation state for the live pane. It lives here rather than in
  // WebPane because the back/forward/reload buttons moved into this
  // toolbar; one subscription now feeds both them and WebPane's own
  // effects.
  const [webState, setWebState] = useState<WebPaneState>(EMPTY_WEB_STATE)

  function patch(input: UpdateBookmarkInput): void {
    if (!bookmark) return
    setActionError(null)
    updateBookmark.mutate(
      { id: bookmark.id, input },
      { onError: (err) => setActionError(`Couldn't save the change. ${errMessage(err)}`) }
    )
  }

  function confirmDelete(): void {
    setPendingDelete(false)
    if (!bookmark) return
    const id = bookmark.id
    setActionError(null)
    deleteBookmark.mutate(id, {
      onSuccess: () => onDeleted(id),
      onError: (err) => setActionError(`Couldn't delete the bookmark. ${errMessage(err)}`)
    })
  }
  // Which highlights the live page could actually anchor. `null` means the
  // page hasn't reported yet, which is different from "none matched" — we
  // only show the "not on page" hint once we've actually heard back.
  const [anchored, setAnchored] = useState<Set<string> | null>(null)
  const [focusHighlightId, setFocusHighlightId] = useState<string | null>(null)

  // A PDF bookmark stores the file under `content.assetId`; older bookmarks
  // only carry it in the assets array, so fall back to that.
  const pdfAssetId = useMemo(() => {
    if (!bookmark || bookmark.content?.type !== 'asset' || bookmark.content?.assetType !== 'pdf') return null
    return bookmark.content.assetId || bookmark.assets.find((a) => a.assetType === 'bookmarkAsset')?.id || null
  }, [bookmark])
  const pdfFileName = bookmark?.content?.fileName || 'document.pdf'

  // Needed by the tab-defaulting effect below, which runs before the
  // early return that used to be the only place `display` was computed.
  const display = useMemo(() => (bookmark ? displayForBookmark(bookmark) : null), [bookmark])
  const url = display?.url

  /**
   * Where a bookmark opens.
   *
   * A stored PDF *is* the bookmark, so it opens on the PDF. Anything with
   * a URL opens on the live page: Preview is a metadata card — title, tags,
   * note, summary — and landing there means every bookmark costs a second
   * click before you can read the thing you saved. Preview is left as the
   * default only for bookmarks that have no page to show: plain text
   * notes, and stored images.
   */
  const defaultTab: Tab = pdfAssetId ? 'pdf' : url ? 'web' : 'preview'

  // The PDF pane reports which highlights it could place, the same way the
  // Web pane's preload does — one list, whichever pane is showing.
  const handleAnchorStatus = useCallback((anchoredIds: string[]) => {
    setAnchored(new Set(anchoredIds))
  }, [])

  // The Web pane's preload posts highlight create/update/delete events to
  // main, which syncs them to the server and then pushes this event back.
  // Without this, a note edited or deleted in the live pane would keep
  // showing its old text in the highlight rail until the bookmark was
  // reselected or the app reloaded.
  useEffect(() => {
    return window.kk.webpane.onHighlightsChanged(({ bookmarkId }) => {
      if (bookmark && bookmarkId === bookmark.id) {
        void queryClient.invalidateQueries({ queryKey: ['highlights', 'bookmark', bookmark.id] })
        void queryClient.invalidateQueries({ queryKey: ['highlights', 'all'] })
      }
    })
  }, [bookmark, queryClient])

  useEffect(() => {
    return window.kk.webpane.onHighlightStatus((payload) => {
      if (!bookmark || payload.bookmarkId !== bookmark.id) return
      setAnchored(new Set(payload.anchored))
    })
  }, [bookmark])

  useEffect(() => {
    setTab(defaultTab)
    setAnchored(null)
    setFocusHighlightId(null)
    // Nav state describes the *previous* bookmark's page until main pushes
    // an update; leaving it would light up Back for a page this bookmark
    // has never been on.
    setWebState(EMPTY_WEB_STATE)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookmark?.id])

  useEffect(() => window.kk.webpane.onState((next) => setWebState(next)), [])

  /**
   * A highlight opened from the sidebar's Highlights view arrives as a
   * prop at the same moment the bookmark changes. The effect above resets
   * the pane for the new bookmark and would clear it again, so this runs
   * after it (effect order within a component is top-to-bottom) and jumps
   * straight to the pane that can show it.
   */
  useEffect(() => {
    if (!externalFocusHighlightId || !bookmark) return
    setFocusHighlightId(externalFocusHighlightId)
    setTab(pdfAssetId ? 'pdf' : 'web')
    setRailOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalFocusHighlightId, bookmark?.id, pdfAssetId])

  useEffect(() => {
    if (bookmark && window.kk.dev.isSmoke) {
      window.kk.dev.notifyDetailReady()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookmark?.id])

  // Now that Web is the default tab, "we are on the Web tab" is true from
  // the moment a bookmark is selected — so the smoke harness must key its
  // web screenshot off the explicit switch it asked for, not off the tab
  // value, or it would capture step 3 before step 2's page had settled.
  // State, not a ref: with Web as the default tab the harness's
  // setTab('web') is a no-op, React bails out of the re-render, and an
  // effect keyed only on `tab` would never re-run — so the run would stall
  // until its 25s safety timeout instead of reporting the page ready.
  const [smokeSwitchedToWeb, setSmokeSwitchedToWeb] = useState(false)
  useEffect(() => {
    if (!window.kk.dev.isSmoke) return
    window.kk.dev.onSwitchToWeb(() => {
      setSmokeSwitchedToWeb(true)
      setTab('web')
    })
  }, [])

  useEffect(() => {
    if (tab === 'web' && smokeSwitchedToWeb && window.kk.dev.isSmoke) {
      const t = setTimeout(() => window.kk.dev.notifyWebReady(), 1500)
      return () => clearTimeout(t)
    }
    return undefined
  }, [tab, smokeSwitchedToWeb])

  function openHighlight(h: Highlight): void {
    setFocusHighlightId(h.id)
    setTab(pdfAssetId ? 'pdf' : 'web')
  }

  function clearFocus(): void {
    setFocusHighlightId(null)
    onFocusHighlightHandled?.()
  }

  if (!bookmark) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <Icon name="library" size={32} className="text-neutral-300 dark:text-neutral-700" />
        <div>
          <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">Nothing selected</p>
          <p className="mt-1 text-xs text-neutral-400">
            {listCollapsed
              ? 'The bookmark list is hidden.'
              : 'Pick a bookmark on the left, or use ↑ and ↓ to move through the list.'}
          </p>
        </div>
        {listCollapsed && (
          <button
            onClick={onExpandList}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Show bookmark list
          </button>
        )}
      </div>
    )
  }

  const content = bookmark.content
  const title = display?.title ?? 'Untitled'
  const tabs: Tab[] = ['preview', ...(pdfAssetId ? (['pdf'] as Tab[]) : []), 'web']
  // On the Web tab the page may have been navigated away from the
  // bookmark's own URL. Copying and opening should follow where the user
  // actually is — and, with the address bar gone, the tooltip is now the
  // only place that current URL is visible.
  const activeUrl = (tab === 'web' ? webState.url || url : url) ?? ''

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-neutral-200 px-3 pt-2 dark:border-neutral-800">
        {/*
          No pane-expand control here. This toolbar is for actions on the
          bookmark; "show the bookmark list" is window chrome, and it lives
          in the window's title row (Sidebar's header, or TitlebarSlot when
          the sidebar is hidden). Putting a copy here as well is what
          produced two identical chevrons fifty pixels apart with both
          panes collapsed.
        */}
        {tabs.map((t) => (
          <button
            key={t}
            data-testid={`tab-${t}`}
            onClick={() => setTab(t)}
            className={`rounded-t-md px-3 py-1.5 text-sm capitalize transition-colors ${
              tab === t
                ? 'border-b-2 border-emerald-600 font-medium text-emerald-700 dark:text-emerald-400'
                : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
            }`}
          >
            {t === 'web' ? 'Web' : t === 'pdf' ? 'PDF' : 'Preview'}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-0.5 pb-1.5">
          {/* Live-page navigation, only while the live page is showing.
              These were the useful half of the toolbar that used to sit
              under the tab row alongside the read-only address field. */}
          {tab === 'web' && url && (
            <>
              <button
                type="button"
                onClick={() => window.kk.webpane.back()}
                disabled={!webState.canGoBack}
                title="Back"
                aria-label="Back"
                className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-neutral-800"
              >
                <Icon name="arrow-left" />
              </button>
              <button
                type="button"
                onClick={() => window.kk.webpane.forward()}
                disabled={!webState.canGoForward}
                title="Forward"
                aria-label="Forward"
                className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-neutral-800"
              >
                <Icon name="arrow-right" />
              </button>
              <button
                type="button"
                onClick={() => (webState.isLoading ? window.kk.webpane.stop() : window.kk.webpane.reload())}
                title={webState.isLoading ? 'Stop' : 'Reload'}
                aria-label={webState.isLoading ? 'Stop loading' : 'Reload'}
                className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
              >
                <Icon name={webState.isLoading ? 'close' : 'reload'} />
              </button>
              <span className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-800" aria-hidden />
            </>
          )}

          {activeUrl && (
            <>
              <CopyLinkButton url={activeUrl} />
              <button
                type="button"
                onClick={() => window.kk.webpane.openExternal(activeUrl)}
                title={`Open in your default browser — ${activeUrl}`}
                className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                <Icon name="external" size={13} />
                Open in browser
              </button>
              <span className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-800" aria-hidden />
            </>
          )}

          {highlights.length > 0 && (
            <button
              type="button"
              onClick={() => setRailOpen(!railOpen)}
              aria-pressed={railOpen}
              title={railOpen ? 'Hide highlights' : 'Show highlights'}
              className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs ${
                railOpen
                  ? 'bg-neutral-200/70 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200'
                  : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800'
              }`}
            >
              <Icon name="highlight" size={14} />
              <span className="tabular-nums">{highlights.length}</span>
            </button>
          )}
          <button
            type="button"
            data-testid="detail-favourite"
            onClick={() => patch({ favourited: !bookmark.favourited })}
            aria-pressed={!!bookmark.favourited}
            aria-label={bookmark.favourited ? 'Remove from favourites' : 'Add to favourites'}
            title={bookmark.favourited ? 'Remove from favourites (F)' : 'Add to favourites (F)'}
            className={`grid h-7 w-7 place-items-center rounded-md ${
              bookmark.favourited
                ? 'text-amber-500 hover:bg-amber-500/10'
                : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800'
            }`}
          >
            <Icon name={bookmark.favourited ? 'star-filled' : 'star'} />
          </button>
          <button
            type="button"
            data-testid="detail-archive"
            onClick={() => patch({ archived: !bookmark.archived })}
            aria-pressed={!!bookmark.archived}
            aria-label={bookmark.archived ? 'Unarchive' : 'Archive'}
            title={bookmark.archived ? 'Unarchive (E)' : 'Archive (E)'}
            className={`grid h-7 w-7 place-items-center rounded-md ${
              bookmark.archived
                ? 'bg-neutral-200/70 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200'
                : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800'
            }`}
          >
            <Icon name="archive" />
          </button>
          <button
            type="button"
            data-testid="detail-delete"
            onClick={() => setPendingDelete(true)}
            aria-label="Delete bookmark"
            title="Delete bookmark"
            className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>

      {actionError && (
        <div className="flex items-start justify-between gap-2 border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} className="flex-shrink-0 font-medium hover:underline">
            Dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <div className={tab === 'preview' ? 'h-full overflow-y-auto' : 'hidden'}>
            <div className="p-5">
              {content?.imageAssetId && (
                <AssetImage
                  assetId={content.imageAssetId}
                  className="mb-4 max-h-64 w-full rounded-lg object-cover"
                />
              )}
              {bookmark.archived && (
                <div className="mb-2 inline-block rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                  Archived
                </div>
              )}
              {/* Editing writes bookmark.title; clearing it sends null, which
                  puts the crawled page title back in charge (see
                  lib/bookmarkDisplay.ts) rather than leaving a blank heading. */}
              <EditableField
                label="title"
                value={title}
                placeholder="Untitled"
                onCommit={(next) => patch({ title: next.trim() || null })}
                displayClassName="mb-1 text-lg font-semibold leading-snug"
                inputClassName="mb-1 text-lg font-semibold leading-snug"
              />
              {url && (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    window.kk.webpane.openExternal(url)
                  }}
                  title={url}
                  className="mb-3 flex items-center gap-1 truncate text-xs text-emerald-600 hover:underline dark:text-emerald-400"
                >
                  <span className="truncate">{url}</span>
                  <Icon name="external" size={11} />
                </a>
              )}
              <TagEditor bookmark={bookmark} />
              <ListMembership bookmarkId={bookmark.id} />
              {content?.description && (
                <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-300">{content.description}</p>
              )}
              {display?.kind === 'text' && content?.text && (
                <blockquote className="mb-4 rounded-lg border-l-4 border-neutral-300 bg-neutral-50 p-3 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
                  {content.text}
                </blockquote>
              )}
              {display?.kind === 'asset' && (
                <div className="mb-4 flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
                  <span className="text-2xl">{content?.assetType === 'pdf' ? '📄' : '📎'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-neutral-800 dark:text-neutral-200">
                      {display?.subtitle || 'Attached file'}
                    </div>
                    {content?.size && (
                      <div className="text-xs text-neutral-500">{(content.size / 1024 / 1024).toFixed(1)} MB</div>
                    )}
                  </div>
                </div>
              )}
              {/* Note comes before Summary now that both are editable: the
                  note is the user's own writing and the summary is generated,
                  so the thing they'd want to reach for sits higher. Both are
                  rendered unconditionally — an empty note that can't be seen
                  is an empty note that can't be written. The amber card is
                  reserved for a note that actually says something; an empty
                  one is quiet, so a blank field isn't the loudest thing on
                  the page. */}
              <div
                className={`mb-4 rounded-lg border p-3 text-sm ${
                  bookmark.note
                    ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
                    : 'border-neutral-200 bg-transparent text-neutral-700 dark:border-neutral-800 dark:text-neutral-300'
                }`}
              >
                <div
                  className={`mb-1 text-xs font-semibold uppercase ${
                    bookmark.note ? 'text-amber-600 dark:text-amber-500' : 'text-neutral-400'
                  }`}
                >
                  Note
                </div>
                <EditableField
                  label="note"
                  multiline
                  value={bookmark.note || ''}
                  placeholder="Add a note…"
                  onCommit={(next) => patch({ note: next.trim() || null })}
                  displayClassName="whitespace-pre-wrap"
                  inputClassName="text-sm"
                />
              </div>
              <div className="mb-4 rounded-lg bg-neutral-50 p-3 text-sm text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
                <div className="mb-1 text-xs font-semibold uppercase text-neutral-400">Summary</div>
                <EditableField
                  label="summary"
                  multiline
                  value={bookmark.summary || ''}
                  placeholder="No summary yet — click to write one."
                  onCommit={(next) => patch({ summary: next.trim() || null })}
                  displayClassName="whitespace-pre-wrap"
                  inputClassName="text-sm"
                />
              </div>
            </div>
          </div>

          {pdfAssetId && (
            <div className={tab === 'pdf' ? 'h-full' : 'hidden'}>
              <PdfPane
                assetId={pdfAssetId}
                fileName={pdfFileName}
                bookmarkId={bookmark.id}
                highlights={highlights}
                focusHighlightId={tab === 'pdf' ? focusHighlightId : null}
                onFocusHandled={clearFocus}
                onAnchorStatus={handleAnchorStatus}
              />
            </div>
          )}

          <div className={tab === 'web' ? 'h-full' : 'hidden'}>
            {url ? (
              <WebPane
                active={tab === 'web'}
                url={url}
                bookmarkId={bookmark.id}
                highlights={highlights}
                state={webState}
                focusHighlightId={focusHighlightId}
                onFocusHandled={clearFocus}
              />
            ) : (
              <div className="p-5 text-sm text-neutral-400">
                {display?.kind === 'asset'
                  ? 'This bookmark is a stored file with no source URL to load live.'
                  : display?.kind === 'text'
                    ? 'This note has no source URL to load live.'
                    : 'This bookmark has no URL to load.'}
              </div>
            )}
          </div>
        </div>

        {railOpen && highlights.length > 0 && (
          <HighlightRail
            highlights={highlights}
            anchored={anchored}
            activeId={focusHighlightId}
            inPdf={!!pdfAssetId}
            onOpen={openHighlight}
            onClose={() => setRailOpen(false)}
          />
        )}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete "${title}"?`}
          description="This deletes the bookmark from Karakeep entirely, along with its tags, notes and highlights. It cannot be undone. To just get it out of the way, archive it instead."
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(false)}
        />
      )}
    </div>
  )
}

/**
 * This bookmark's highlights, alongside whichever pane is showing.
 *
 * It sits *beside* the content rather than inside the Preview scroll body
 * so that clicking a highlight — which switches to the PDF or Web pane and
 * scrolls it into view — doesn't take the list itself off screen. The Web
 * pane's native WebContentsView tracks its container's rect through a
 * ResizeObserver (see WebPane.tsx), so opening and closing the rail
 * repositions the live page automatically.
 */
function HighlightRail({
  highlights,
  anchored,
  activeId,
  inPdf,
  onOpen,
  onClose
}: {
  highlights: Highlight[]
  anchored: Set<string> | null
  activeId: string | null
  inPdf: boolean
  onOpen: (h: Highlight) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <aside className="flex w-72 flex-shrink-0 flex-col border-l border-neutral-200 bg-neutral-50/50 dark:border-neutral-800 dark:bg-neutral-900/30">
      <div className="flex items-center gap-1.5 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Highlights <span className="tabular-nums text-neutral-500">{highlights.length}</span>
        </span>
        <button
          onClick={onClose}
          aria-label="Hide highlights"
          title="Hide highlights"
          className="grid h-6 w-6 place-items-center rounded text-neutral-400 hover:bg-neutral-200/70 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <Icon name="close" size={13} />
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {highlights.map((h) => {
          const missing = anchored !== null && !anchored.has(h.id)
          return (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => onOpen(h)}
                title={inPdf ? 'Show in the PDF' : 'Show on the live page'}
                className={`flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  h.id === activeId
                    ? 'bg-emerald-600/10'
                    : 'hover:bg-neutral-200/60 dark:hover:bg-neutral-800/70'
                }`}
              >
                <span
                  aria-hidden
                  className="mt-0.5 w-1 shrink-0 self-stretch rounded-full"
                  style={{ backgroundColor: colorFor(h.color) }}
                />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-4 text-xs leading-snug text-neutral-700 dark:text-neutral-200">
                    {h.text}
                  </span>
                  {h.note && (
                    <span className="mt-1 block text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
                      {h.note}
                    </span>
                  )}
                  {missing && (
                    <span className="mt-1 block text-[11px] text-neutral-400">
                      {inPdf ? 'Not found in this PDF' : 'Not found on the current page'}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

/**
 * Copy the current link.
 *
 * Confirmation is the icon itself flipping to a tick for a moment.
 * Copying is silent by nature — without some acknowledgement the only way
 * to know it worked is to go and paste somewhere — and a toast for
 * something this small would be louder than the action.
 */
function CopyLinkButton({ url }: { url: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  // A component unmounted inside the confirmation window (switching
  // bookmarks straight after copying) would otherwise set state on a dead
  // component.
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [copied])

  // Reset if the link changes under us — a tick left over from the
  // previous page would be claiming something untrue about this one.
  useEffect(() => setCopied(false), [url])

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          .writeText(url)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }}
      title={copied ? 'Copied' : `Copy link — ${url}`}
      aria-label="Copy link"
      className={`grid h-7 w-7 place-items-center rounded-md ${
        copied
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800'
      }`}
    >
      <Icon name={copied ? 'check' : 'copy'} />
    </button>
  )
}
