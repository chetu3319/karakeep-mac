import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Highlight, WebPaneState } from '../../../shared/types'
import type { StudyAttachment, StudyMessage } from '../../../shared/study'
import FindBar, { type FindResult } from './FindBar'
import type { FindStep } from '../lib/findStep'
import { onWebPaneShown, setWebPaneWanted } from '../lib/webPaneVisibility'

/**
 * The live page, and nothing else.
 *
 * This used to carry its own toolbar: back / forward / reload, a read-only
 * address field, and an "Open in Safari" button. That put a third bar of
 * chrome under the window titlebar and the tab row, and the address field
 * — the widest thing in it — was pure display, not a control. Those
 * actions now live in the detail pane's utility bar next to favourite and
 * archive, where every other per-bookmark action already is, so the live
 * page gets the whole pane.
 *
 * Navigation *state* is owned by DetailPane and passed in, so one
 * subscription feeds both the buttons and this component's own effects.
 */
export default function WebPane({
  active,
  url,
  bookmarkId,
  highlights,
  state,
  focusHighlightId,
  onFocusHandled,
  findOpen,
  findFocusSignal,
  findStep,
  onFindClose
}: {
  active: boolean
  url: string
  bookmarkId: string
  highlights: Highlight[]
  state: WebPaneState
  /** Highlight to scroll to once the page is loaded (set by the highlight rail). */
  focusHighlightId?: string | null
  onFocusHandled?: () => void
  /** Attach a selection or region to the Study panel's next question. Wired up by the selection tools. */
  onStudyAttach?: (attachment: StudyAttachment) => void
  /** Open Study with an exchange already in it ("Continue in Study"). */
  onStudyContinue?: (messages: StudyMessage[]) => void
  findOpen: boolean
  findFocusSignal: number
  /** ⌘G / ⇧⌘G from the menu, as a new object per press. */
  findStep: FindStep | null
  onFindClose: () => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  // ── Find in page ──────────────────────────────────────────────────────
  // The bar is a strip above the container, so opening it shrinks the
  // container and the bounds effect below moves the native view down — the
  // view never has to be drawn "under" anything.
  const [findResult, setFindResult] = useState<FindResult | null>(null)
  const query = useRef('')

  useEffect(() => {
    if (!findOpen) return
    const off = window.kk.webpane.onFound((r) => {
      // Chromium reports ordinal 0 on interim updates before it has chosen a
      // match; showing "0 of 12" for a frame reads as a glitch.
      setFindResult({ current: r.activeMatchOrdinal, total: r.matches })
    })
    return () => {
      off()
      query.current = ''
      setFindResult(null)
      void window.kk.webpane.stopFind()
    }
  }, [findOpen])

  const runQuery = useCallback((q: string) => {
    query.current = q
    if (!q) {
      setFindResult(null)
      void window.kk.webpane.stopFind()
      return
    }
    void window.kk.webpane.find(q, { forward: true, newSession: true })
  }, [])
  const step = useCallback((forward: boolean) => {
    if (query.current) void window.kk.webpane.find(query.current, { forward, newSession: false })
  }, [])

  useEffect(() => {
    if (findOpen && findStep) step(findStep.forward)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findStep])

  // A navigation inside the page (link click) drops the old matches in main;
  // search the new document for the same text if the bar is still up.
  useEffect(() => {
    if (findOpen && query.current && !state.isLoading) runQuery(query.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.url, state.isLoading])

  // Navigate whenever the active bookmark/url changes.
  useEffect(() => {
    if (!active) return
    void window.kk.webpane.navigate(url, bookmarkId, highlights)
    // We intentionally only re-navigate on url/bookmarkId change, not on
    // every highlights array identity change (see effect below for that).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, url, bookmarkId])

  // Re-push highlights whenever the set changes, *without* re-navigating.
  // The highlights query usually resolves after the first navigate, so the
  // navigate above often carries an empty list; a page that never hears the
  // real list renders none of its highlights. Keyed on a content signature
  // so a mere array-identity change doesn't cause needless IPC.
  const signature = highlights
    .map((h) => `${h.id}:${h.color ?? ''}:${h.note ?? ''}`)
    .sort()
    .join('|')
  useEffect(() => {
    if (!active) return
    void window.kk.webpane.applyHighlights(highlights)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, bookmarkId, signature])

  // Scroll to a highlight the user clicked in the rail, once the page has
  // actually finished loading (marks don't exist before that).
  useEffect(() => {
    if (!active || !focusHighlightId || state.isLoading) return
    const t = setTimeout(() => {
      void window.kk.webpane.focusHighlight(focusHighlightId)
      onFocusHandled?.()
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focusHighlightId, state.isLoading])

  // Show/hide the native view as the tab becomes active/inactive — through
  // the coordinator, because a dialog on screen also gets a say (it would
  // otherwise be painted underneath the live page). See lib/webPaneVisibility.
  useEffect(() => {
    setWebPaneWanted(active)
    return () => setWebPaneWanted(false)
  }, [active])

  // Keep native view bounds in sync with the container's on-screen rect.
  useEffect(() => {
    if (!active) return
    const el = containerRef.current
    if (!el) return

    function report(): void {
      if (!el) return
      const rect = el.getBoundingClientRect()
      void window.kk.webpane.setBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      })
    }

    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    window.addEventListener('scroll', report, true)
    // A pane that was hidden for a dialog comes back to a layout that may
    // have moved on without it, and a hidden element's ResizeObserver never
    // fired for those changes.
    const offShown = onWebPaneShown(report)
    return () => {
      ro.disconnect()
      offShown()
      window.removeEventListener('resize', report)
      window.removeEventListener('scroll', report, true)
    }
  }, [active])

  return (
    <div className="relative flex h-full flex-col">
      {state.error && (
        <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          Failed to load: {state.error}
        </div>
      )}
      {findOpen && (
        <FindBar
          result={findResult}
          focusSignal={findFocusSignal}
          onQuery={runQuery}
          onNext={() => step(true)}
          onPrevious={() => step(false)}
          onClose={onFindClose}
        />
      )}
      <div ref={containerRef} className="min-h-0 flex-1" data-testid="webpane-container" />
    </div>
  )
}
