import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import type { Highlight } from '../../../shared/types'
import { errMessage } from '../lib/errors'
import { applyHighlights, flashMark, marksFor } from '../lib/readerAnchor'
import { buildReaderDocument, sanitizeReaderHtml } from '../lib/readerContent'

/**
 * The cached reader view, rendered inside the Preview tab.
 *
 * The article is third-party HTML, so it goes into a frame that cannot run
 * anything: `sandbox="allow-same-origin"` with no `allow-scripts`. Those two
 * flags together are deliberate and easy to get wrong —
 *
 *   - without `allow-same-origin` the frame gets an opaque origin and this
 *     renderer can't reach `contentDocument`, which is where the highlights
 *     have to be placed;
 *   - adding `allow-scripts` alongside it is the combination everyone warns
 *     about, because a script inside could then strip its own sandbox.
 *
 * As written, no script in the frame ever executes, and the parent still has
 * full DOM access to it. The HTML is sanitised on the way in as well (see
 * lib/readerContent.ts); the sandbox is what holds if the sanitiser doesn't.
 *
 * The frame carries no scrollbar of its own: it is sized to its content and
 * scrolls with the rest of the Preview tab, so the article reads as one page
 * with the bookmark's own metadata above it rather than as a box inside a
 * box.
 */

export interface ReaderPaneProps {
  assetId: string
  /** The bookmark's URL, used to resolve any relative links the article kept. */
  baseUrl?: string | null
  highlights: Highlight[]
  /** Highlight to scroll to, set when one is clicked in the list above. */
  focusHighlightId?: string | null
  onFocusHandled?: () => void
  /** Reports which highlights could be placed in the reader text. */
  onAnchorStatus?: (anchored: string[]) => void
}

/** Height the frame starts at, before its content has been measured. */
const INITIAL_HEIGHT = 320

/** The nearest ancestor that actually scrolls — the Preview tab's body. */
function scrollableAncestor(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return null
}

export default function ReaderPane({
  assetId,
  baseUrl,
  highlights,
  focusHighlightId,
  onFocusHandled,
  onAnchorStatus
}: ReaderPaneProps): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [frameDoc, setFrameDoc] = useState<Document | null>(null)
  const [height, setHeight] = useState(INITIAL_HEIGHT)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['reader', assetId],
    queryFn: () => window.kk.assets.getBytes(assetId),
    // The reader view is a snapshot of a crawl; it doesn't change until the
    // bookmark is re-crawled, so there is nothing to gain by refetching a
    // few hundred kilobytes every time the user comes back to it.
    staleTime: 30 * 60_000,
    enabled: !!assetId
  })

  const srcDoc = useMemo(() => {
    if (!data) return null
    // Karakeep stores the reader HTML as UTF-8; the asset endpoint hands
    // back bytes, not an encoding, so there is nothing else to honour.
    const html = new TextDecoder('utf-8').decode(new Uint8Array(data))
    return buildReaderDocument(sanitizeReaderHtml(html, baseUrl))
  }, [data, baseUrl])

  // A new article means the old frame document is gone; drop the reference
  // so nothing tries to place highlights into a detached DOM.
  useEffect(() => {
    setFrameDoc(null)
    setHeight(INITIAL_HEIGHT)
  }, [srcDoc])

  const measure = useCallback((doc: Document) => {
    if (!doc.documentElement) return
    const measured = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0)
    // A one-pixel wobble as images settle would otherwise re-render on every
    // observer callback.
    setHeight((prev) => (Math.abs(prev - measured) > 1 ? measured : prev))
  }, [])

  const handleLoad = useCallback(() => {
    const doc = frameRef.current?.contentDocument
    // No srcDoc yet means this is the empty initial load of the frame.
    if (!doc || !doc.body || !srcDoc) return
    setFrameDoc(doc)
    measure(doc)
  }, [measure, srcDoc])

  // Height tracking. The frame has no scrollbar of its own, so its height has
  // to follow its content — which keeps moving as the article's images
  // arrive.
  useEffect(() => {
    if (!frameDoc) return
    const observer = new ResizeObserver(() => measure(frameDoc))
    if (frameDoc.documentElement) observer.observe(frameDoc.documentElement)
    if (frameDoc.body) observer.observe(frameDoc.body)
    const view = frameDoc.defaultView
    const onResize = (): void => measure(frameDoc)
    view?.addEventListener('load', onResize)
    return () => {
      observer.disconnect()
      view?.removeEventListener('load', onResize)
    }
  }, [frameDoc, measure])

  // Links open in the user's browser. Left alone they would navigate the
  // frame itself, replacing the cached article with a live page load — which
  // is both a surprise and the one thing this pane exists to avoid.
  useEffect(() => {
    if (!frameDoc) return
    const onClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!anchor) return
      event.preventDefault()
      const href = anchor.getAttribute('href')
      if (href) void window.kk.webpane.openExternal(href)
    }
    frameDoc.addEventListener('click', onClick)
    return () => frameDoc.removeEventListener('click', onClick)
  }, [frameDoc])

  useEffect(() => {
    if (!frameDoc) return
    const anchored = applyHighlights(frameDoc, highlights)
    onAnchorStatus?.(anchored)
    measure(frameDoc)
    if (window.kk.dev.isSmoke) window.kk.dev.notifyReaderReady()
  }, [frameDoc, highlights, measure, onAnchorStatus])

  // Scroll a highlight into view. The frame doesn't scroll — the Preview tab
  // does — so the mark's position inside the frame has to be lifted into the
  // scroller's coordinates by hand.
  useEffect(() => {
    if (!frameDoc || !focusHighlightId) return
    const frame = frameRef.current
    const mark = marksFor(frameDoc, focusHighlightId)[0]
    if (!frame || !mark) return

    const scroller = scrollableAncestor(frame)
    if (scroller) {
      const top =
        mark.getBoundingClientRect().top +
        frame.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop
      scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: 'smooth' })
    }
    const cancelFlash = flashMark(mark)
    onFocusHandled?.()
    return cancelFlash
  }, [frameDoc, focusHighlightId, onFocusHandled])

  if (error) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>Couldn&apos;t load the saved copy. {errMessage(error)}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-2 font-medium text-emerald-700 hover:underline dark:text-emerald-400"
        >
          Try again
        </button>
      </div>
    )
  }

  if (isLoading || !srcDoc) {
    return (
      <div data-testid="reader-loading" className="space-y-2" aria-busy="true">
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className="h-3 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800"
            style={{ width: `${[100, 96, 88, 98, 62][i]}%` }}
          />
        ))}
      </div>
    )
  }

  return (
    <iframe
      ref={frameRef}
      data-testid="reader-frame"
      title="Saved copy"
      // See the note at the top of this file before touching these two.
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={handleLoad}
      scrolling="no"
      className="block w-full border-0"
      style={{ height }}
    />
  )
}
