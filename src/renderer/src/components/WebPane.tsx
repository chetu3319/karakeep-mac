import React, { useEffect, useRef, useState } from 'react'
import type { Highlight, WebPaneState } from '../../../shared/types'

export default function WebPane({
  active,
  url,
  bookmarkId,
  highlights,
  focusHighlightId,
  onFocusHandled
}: {
  active: boolean
  url: string
  bookmarkId: string
  highlights: Highlight[]
  /** Highlight to scroll to once the page is loaded (set by the Preview list). */
  focusHighlightId?: string | null
  onFocusHandled?: () => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<WebPaneState>({
    url,
    title: '',
    isLoading: true,
    canGoBack: false,
    canGoForward: false,
    error: null
  })

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

  // Scroll to a highlight the user clicked in the Preview list, once the
  // page has actually finished loading (marks don't exist before that).
  useEffect(() => {
    if (!active || !focusHighlightId || state.isLoading) return
    const t = setTimeout(() => {
      void window.kk.webpane.focusHighlight(focusHighlightId)
      onFocusHandled?.()
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focusHighlightId, state.isLoading])

  // Show/hide the native view as the tab becomes active/inactive.
  useEffect(() => {
    if (active) {
      void window.kk.webpane.show()
    } else {
      void window.kk.webpane.hide()
    }
    return () => {
      void window.kk.webpane.hide()
    }
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
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      window.removeEventListener('scroll', report, true)
    }
  }, [active])

  useEffect(() => {
    const off = window.kk.webpane.onState((s) => setState(s))
    return off
  }, [])

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
        <button
          onClick={() => window.kk.webpane.back()}
          disabled={!state.canGoBack}
          className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
          title="Back"
        >
          ←
        </button>
        <button
          onClick={() => window.kk.webpane.forward()}
          disabled={!state.canGoForward}
          className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 dark:hover:bg-neutral-800"
          title="Forward"
        >
          →
        </button>
        <button
          onClick={() => (state.isLoading ? window.kk.webpane.stop() : window.kk.webpane.reload())}
          className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          title={state.isLoading ? 'Stop' : 'Reload'}
        >
          {state.isLoading ? '✕' : '⟳'}
        </button>
        <div className="ml-2 flex-1 truncate rounded-md bg-neutral-100 px-2 py-1 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
          {state.url || url}
        </div>
        <button
          onClick={() => window.kk.webpane.openExternal(state.url || url)}
          className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          title="Open in Safari"
        >
          Open in Safari ↗
        </button>
      </div>
      {state.error && (
        <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          Failed to load: {state.error}
        </div>
      )}
      <div ref={containerRef} className="min-h-0 flex-1" data-testid="webpane-container" />
    </div>
  )
}
