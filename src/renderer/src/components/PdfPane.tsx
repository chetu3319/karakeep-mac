import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EmbedPDF, useDocumentState, type PluginBatchRegistrations } from '@embedpdf/core/react'
import { usePdfiumEngine } from '@embedpdf/engines/react'
import { DocumentManagerPluginPackage } from '@embedpdf/plugin-document-manager/react'
import {
  GlobalPointerProvider,
  InteractionManagerPluginPackage,
  PagePointerProvider
} from '@embedpdf/plugin-interaction-manager/react'
import { RenderLayer, RenderPluginPackage } from '@embedpdf/plugin-render/react'
import { SearchLayer, SearchPluginPackage, useSearch } from '@embedpdf/plugin-search/react'
import { Scroller, ScrollPluginPackage, useScroll, type PageLayout } from '@embedpdf/plugin-scroll/react'
import {
  SelectionLayer,
  SelectionPluginPackage,
  rectsWithinSlice,
  useSelectionCapability,
  type SelectionSelectionMenuProps
} from '@embedpdf/plugin-selection/react'
import { Viewport, ViewportPluginPackage } from '@embedpdf/plugin-viewport/react'
import { ZoomMode, ZoomPluginPackage, useZoom } from '@embedpdf/plugin-zoom/react'
import type { PdfDocumentObject, PdfEngine, PdfPageGeometry, Rect } from '@embedpdf/models'
// The wasm ships inside the package; loading it from disk rather than the
// default jsdelivr URL keeps the viewer working offline and keeps the app from
// reaching a host the user never pointed it at.
import pdfiumWasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'

import {
  COPY_CONFIRM_MS,
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS as COLORS,
  ICON_CHECK,
  ICON_COPY,
  ICON_NOTE,
  ICON_STUDY_ATTACH,
  ICON_TRASH,
  hexForColor,
  highlightPopoverStylesheet,
  placePopover
} from '../../../shared/highlightUi'
import type { Highlight } from '../../../shared/types'
import type { StudyAttachment, StudyMessage } from '../../../shared/study'
import { createPdfDocumentReader, type PdfDocumentReader } from '../lib/pdfDocumentReader'
import {
  encodedTooLarge,
  glyphSpansInRect,
  isTinyDrag,
  pickPage,
  rectFromPoints,
  regionLabel,
  renderScaleFor,
  screenToPageRect,
  tidyRegionText,
  type PageBox,
  type PxRect
} from '../../../shared/regionCapture'
import { useCreateHighlight, useDeleteHighlight, useUpdateHighlight } from '../lib/queries'
import { useIsDark, usePref } from '../lib/prefs'
import InlineAnswer from './InlineAnswer'
import { buildContinueMessages, textAttachment, type InlineMode } from '../../../shared/inlineAnswer'
import FindBar, { type FindResult } from './FindBar'
import type { FindStep } from '../lib/findStep'
import {
  buildPageIndex,
  resolveAnchor,
  spansForRange,
  textForSpans,
  toGlobal,
  type AnchorQuality,
  type PageIndex,
  type PageSpan
} from '../lib/pdfAnchor'

/**
 * The Scroller sizes each page wrapper itself and passes only the layout, so
 * the render scale has to come back out of it: laid-out width over the page's
 * intrinsic width.
 */
function scaleFor(doc: PdfDocumentObject | null, layout: PageLayout): number {
  const size = doc?.pages[layout.pageIndex]?.size
  if (!size || !size.width) return 1
  return layout.rotatedWidth / size.width
}

/**
 * The popover stylesheet is shared with the Web pane, and goes into the
 * renderer document once. It is plain CSS rather than Tailwind classes for a
 * reason worth remembering: the two panes have to look identical and only one
 * of them can use Tailwind at all — and a Tailwind opacity step outside the
 * scale (`bg-neutral-900/97`) compiles to nothing at all, which is how this
 * popover once ended up fully transparent.
 */
const POPOVER_STYLE_ID = 'kk-highlight-popover-styles'

function useHighlightPopoverStyles(): void {
  useEffect(() => {
    if (document.getElementById(POPOVER_STYLE_ID)) return
    const el = document.createElement('style')
    el.id = POPOVER_STYLE_ID
    el.textContent = highlightPopoverStylesheet()
    document.head.appendChild(el)
  }, [])
}

/**
 * Night mode inverts the rendered page bitmap in CSS. There is no way to ask
 * PDFium for a dark render — the page is a picture of ink on paper — so the
 * picture is what gets flipped.
 *
 * `invert(0.92)` rather than a full inversion: a full one maps paper to pure
 * #000 and ink to pure #fff, which is the highest-contrast, most tiring
 * combination there is. Backing off lands paper near #141414 and ink near
 * #ebebeb — the same softened pairing the rest of the app's dark theme uses.
 *
 * `hue-rotate(180deg)` puts colour back where it belongs: inversion alone
 * takes a blue diagram to orange, and rotating the wheel a half turn returns
 * the hue while leaving the lightness flip intact. Photographs still come out
 * looking like negatives — that is inherent to the technique, and the reason
 * the toggle exists rather than being always-on in dark mode.
 */
const NIGHT_FILTER = 'invert(0.92) hue-rotate(180deg)'

/** 'auto' follows the app theme; the toggle writes an explicit on/off. */
type NightPref = 'auto' | 'on' | 'off'

/** A highlight that has been located in this document. */
interface PlacedHighlight {
  highlight: Highlight
  spans: PageSpan[]
  quality: AnchorQuality
}

export type { PdfDocumentReader }

/** How long a Study reference flash stays on the page. */
const REF_FLASH_MS = 1500
/** Time a smooth scroll to a nearby page is given before the flash starts. */
const REF_SCROLL_MS = 350

export interface PdfPaneProps {
  assetId: string
  fileName: string
  title?: string
  bookmarkId: string
  highlights: Highlight[]
  /** Highlight to scroll to, set when one is clicked in the Preview tab. */
  focusHighlightId?: string | null
  onFocusHandled?: () => void
  /** Reports which highlights could be located, for the Preview tab's list. */
  onAnchorStatus?: (anchored: string[], missing: string[]) => void
  /** Source/author metadata for the AI context injection — see shared/types.ts AiStreamRequest. */
  sourceUrl?: string
  author?: string
  /**
   * Study reads the whole document through this: the pane hands up a reader
   * once it is mounted and takes it back (null) when it goes away. The
   * reader serves whichever document the pane currently has open.
   */
  onDocumentReader?: (reader: PdfDocumentReader | null) => void
  /** Attach a selection or region to the Study panel's next question. Wired up by the selection tools. */
  onStudyAttach?: (attachment: StudyAttachment) => void
  /** Open Study with an exchange already in it ("Continue in Study"). */
  onStudyContinue?: (messages: StudyMessage[]) => void
  /** Find bar state is owned by the detail pane, which routes the menu's ⌘F/⌘G to it. */
  findOpen: boolean
  findFocusSignal: number
  findStep: FindStep | null
  onFindClose: () => void
}

export default function PdfPane(props: PdfPaneProps): React.JSX.Element {
  const { assetId, fileName, title } = props
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { engine, isLoading: engineLoading, error: engineError } = usePdfiumEngine({
    // Absolute, deliberately. The worker engine runs from a blob: URL, and a
    // blob: URL has an opaque path — nothing relative resolves against it, so
    // the worker's fetch of the wasm silently never completes and the document
    // sits at status 'loading' forever with no error anywhere. A production
    // build happens to escape this (Vite emits `new URL(..., import.meta.url)`,
    // already absolute); `electron-vite dev` serves the bare root-relative
    // `/@fs/...` path, which is how PDFs load in the packaged app and render as
    // a blank pane in dev.
    wasmUrl: new URL(pdfiumWasmUrl, window.location.href).href,
    worker: true,
    // Default is a CDN fetch per script; a bookmark manager has no business
    // phoning a CDN to render a file the user already stored.
    fontFallback: null
  })

  useEffect(() => {
    let cancelled = false
    setBuffer(null)
    setLoadError(null)
    window.kk.assets
      .getBytes(assetId)
      .then((bytes) => {
        if (!cancelled) setBuffer(bytes)
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message || 'Could not download this PDF')
      })
    return () => {
      cancelled = true
    }
  }, [assetId])

  const plugins: PluginBatchRegistrations = useMemo(
    () =>
      buffer
        ? ([
            {
              package: DocumentManagerPluginPackage,
              config: {
                initialDocuments: [{ buffer, name: fileName || 'document.pdf', documentId: assetId }]
              }
            },
            { package: ViewportPluginPackage, config: { viewportGap: 16 } },
            { package: ScrollPluginPackage, config: {} },
            { package: RenderPluginPackage, config: {} },
            { package: InteractionManagerPluginPackage, config: {} },
            { package: SelectionPluginPackage, config: {} },
            { package: SearchPluginPackage, config: {} },
            { package: ZoomPluginPackage, config: {
                // The plugin's own ceiling is 60x, which a pinch reaches in a
                // couple of strokes and which only shows a few glyphs.
                defaultZoomLevel: ZoomMode.FitWidth,
                maxZoom: 6
              }
            }
          ] as PluginBatchRegistrations)
        : [],
    [buffer, assetId, fileName]
  )

  if (loadError || engineError) {
    return <PdfMessage tone="error">{loadError || engineError?.message || 'PDF engine failed to start'}</PdfMessage>
  }
  if (!buffer || engineLoading || !engine) {
    return <PdfMessage>Loading PDF…</PdfMessage>
  }

  return (
    <div className="flex h-full flex-col bg-neutral-100 dark:bg-neutral-950">
      <EmbedPDF engine={engine as PdfEngine} plugins={plugins}>
        <PdfSurface {...props} engine={engine as PdfEngine} />
      </EmbedPDF>
    </div>
  )
}

function PdfMessage({
  children,
  tone = 'muted'
}: {
  children: React.ReactNode
  tone?: 'muted' | 'error'
}): React.JSX.Element {
  return (
    <div
      className={`flex h-full items-center justify-center p-6 text-center text-sm ${
        tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-neutral-400'
      }`}
    >
      {children}
    </div>
  )
}

/**
 * Everything below here runs inside the EmbedPDF provider, so the plugin
 * hooks are available.
 */
function PdfSurface({
  assetId,
  fileName,
  title,
  bookmarkId,
  highlights,
  focusHighlightId,
  onFocusHandled,
  onAnchorStatus,
  sourceUrl,
  author,
  onDocumentReader,
  onStudyAttach,
  onStudyContinue,
  findOpen,
  findFocusSignal,
  findStep,
  onFindClose,
  engine
}: PdfPaneProps & { engine: PdfEngine }): React.JSX.Element {
  const documentId = assetId
  useHighlightPopoverStyles()
  const docState = useDocumentState(documentId)
  const doc = docState?.document ?? null
  const { provides: selection } = useSelectionCapability()
  const { provides: scroll, state: scrollState } = useScroll(documentId)
  // The scroll plugin only knows the page count once it has laid pages out;
  // the document has known it since it opened.
  const totalPages = doc?.pageCount ?? scrollState.totalPages
  const { provides: zoom, state: zoomState } = useZoom(documentId)

  // ── Trackpad pinch ────────────────────────────────────────────────────
  // Chromium reports a trackpad pinch as `wheel` events with `ctrlKey` set
  // and the pinch amount in `deltaY`; a plain two-finger scroll has no
  // `ctrlKey` and is left alone. The plugin's own `requestZoomBy` rounds the
  // result to 0.01, which swallows the small per-event deltas of a pinch, so
  // this asks for an absolute level instead (the plugin still clamps it to
  // its min/max and keeps the point under `center` fixed while scrolling).
  const pinchHostRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  useEffect(() => {
    const host = pinchHostRef.current
    if (!host) return
    let factor = 1
    let center = { vx: 0, vy: 0 }
    let frame = 0
    // Several wheel events land per frame; relaying out the pages for each
    // one is what makes pinch janky, so they are folded into one request.
    const apply = (): void => {
      frame = 0
      const z = zoomRef.current
      if (!z) return
      const level = z.getState().currentZoomLevel * factor
      factor = 1
      z.requestZoom(level, center)
    }
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      // Without this Chromium would page-zoom the whole app window.
      e.preventDefault()
      const rect = host.getBoundingClientRect()
      center = { vx: e.clientX - rect.left, vy: e.clientY - rect.top }
      factor *= Math.exp(-e.deltaY * 0.01)
      if (!frame) frame = requestAnimationFrame(apply)
    }
    // Non-passive, or `preventDefault` is ignored.
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      host.removeEventListener('wheel', onWheel)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  // ── Find in document ──────────────────────────────────────────────────
  // The search plugin finds and keeps the results; it does not scroll, so
  // the active match is brought into view here, the same way a highlight
  // picked in the rail is.
  const { state: searchState, provides: search } = useSearch(documentId)
  useEffect(() => {
    if (!findOpen || !search) return
    search.startSearch()
    return () => {
      // Stopping also hides the highlight layer, and empties the query so a
      // reopened bar doesn't resume on stale matches.
      void search.searchAllPages('')
      search.stopSearch()
    }
  }, [findOpen, search])

  useEffect(() => {
    if (!findOpen || !findStep || !search) return
    if (findStep.forward) search.nextResult()
    else search.previousResult()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findStep])

  const activeMatch = searchState.results[searchState.activeResultIndex]
  useEffect(() => {
    if (!findOpen || !activeMatch || !scroll) return
    const rect = activeMatch.rects[0]
    scroll.scrollToPage({
      pageNumber: activeMatch.pageIndex + 1,
      pageCoordinates: rect ? { x: rect.origin.x, y: rect.origin.y } : undefined,
      behavior: 'smooth',
      alignY: 30
    })
    // Keyed on the match, not on `scroll`'s identity, which changes on layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, activeMatch])

  const findResult: FindResult | null =
    findOpen && searchState.query && !searchState.loading
      ? { current: searchState.total > 0 ? searchState.activeResultIndex + 1 : 0, total: searchState.total }
      : null

  const createHighlight = useCreateHighlight()
  const updateHighlight = useUpdateHighlight()
  const deleteHighlight = useDeleteHighlight()

  const [index, setIndex] = useState<PageIndex | null>(null)
  const [indexFailed, setIndexFailed] = useState(false)
  const indexFailedRef = useRef(false)
  indexFailedRef.current = indexFailed
  const [indexing, setIndexing] = useState<{ done: number; total: number } | null>(null)
  const geometry = useRef<Map<number, PdfPageGeometry>>(new Map())
  const pageTextCache = useRef<Map<number, string>>(new Map())
  const [placed, setPlaced] = useState<PlacedHighlight[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const lastCreatedId = useRef<string | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  // A passage Study is pointing at. Drawn like a focused highlight but never
  // stored: it is cleared after FLASH_MS and nothing is sent to the server.
  const [refFlash, setRefFlash] = useState<{ page: number; from: number; to: number } | null>(null)
  const refFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (refFlashTimer.current) clearTimeout(refFlashTimer.current)
  }, [])

  // ── Text index ────────────────────────────────────────────────────────────
  // One pass over the document's geometry, which gives both the glyph counts
  // the offsets are built from and the rects the overlay draws.
  useEffect(() => {
    if (!doc) return
    let cancelled = false
    setIndex(null)
    setIndexFailed(false)
    setIndexing({ done: 0, total: doc.pages.length })
    geometry.current = new Map()
    pageTextCache.current = new Map()

    void buildPageIndex(engine, doc, (done, total) => {
      if (!cancelled) setIndexing({ done, total })
    })
      .then(({ index: built, geometry: geo }) => {
        if (cancelled) return
        geometry.current = geo
        setIndex(built)
        setIndexing(null)
      })
      .catch(() => {
        if (!cancelled) {
          setIndexing(null)
          setIndexFailed(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [doc, engine])

  const pageText = useCallback(
    async (page: number): Promise<string> => {
      const cached = pageTextCache.current.get(page)
      if (cached !== undefined) return cached
      if (!doc || !index) return ''
      const count = index.pageCounts[page] ?? 0
      const text = count === 0 ? '' : await textForSpans(engine, doc, [{ page, from: 0, to: count - 1 }])
      pageTextCache.current.set(page, text)
      return text
    },
    [doc, engine, index]
  )

  // ── Locate stored highlights ──────────────────────────────────────────────
  useEffect(() => {
    if (!doc || !index) return
    let cancelled = false

    void (async () => {
      const results: PlacedHighlight[] = []
      for (const highlight of highlights) {
        const anchor = await resolveAnchor(engine, doc, index, pageText, highlight)
        results.push({ highlight, spans: anchor.spans, quality: anchor.quality })
      }
      if (cancelled) return
      setPlaced(results)
      onAnchorStatus?.(
        results.filter((r) => r.quality !== 'missing').map((r) => r.highlight.id),
        results.filter((r) => r.quality === 'missing').map((r) => r.highlight.id)
      )
    })()

    return () => {
      cancelled = true
    }
    // `onAnchorStatus` is a render-stable callback from the parent; including
    // it would re-run the whole resolve pass on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, index, highlights, engine, pageText])

  // ── Jump to a highlight picked in the Preview tab ──────────────────────────
  useEffect(() => {
    if (!focusHighlightId || !scroll) return
    const target = placed.find((p) => p.highlight.id === focusHighlightId)
    if (!target || target.spans.length === 0) {
      onFocusHandled?.()
      return
    }
    const span = target.spans[0]
    const geo = geometry.current.get(span.page)
    const rect = geo ? rectsWithinSlice(geo, span.from, span.to)[0] : undefined
    scroll.scrollToPage({
      pageNumber: span.page + 1,
      pageCoordinates: rect ? { x: rect.origin.x, y: rect.origin.y } : undefined,
      behavior: 'smooth',
      alignY: 30
    })
    setActiveId(target.highlight.id)
    setFlashId(target.highlight.id)
    const timer = setTimeout(() => setFlashId(null), 1600)
    onFocusHandled?.()
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusHighlightId, placed, scroll])

  // ── Creating a highlight from the current selection ────────────────────────
  const createFromSelection = useCallback(
    async (color: string, withNote: boolean): Promise<string | null> => {
      if (!selection || !index || !doc) return null
      const scope = selection.forDocument(documentId)
      const range = scope.getState().selection
      if (!range) {
        if (window.kk.dev.isSmoke) console.log('[smoke-pdf] createFromSelection: selection was already gone')
        return null
      }

      const a = toGlobal(index, range.start.page, range.start.index)
      const b = toGlobal(index, range.end.page, range.end.index)
      const start = Math.min(a, b)
      const end = Math.max(a, b) + 1

      const text = (await textForSpans(engine, doc, spansForRange(index, start, end))).trim()
      if (!text) return null

      const created = await createHighlight.mutateAsync({
        bookmarkId,
        startOffset: start,
        endOffset: end,
        color,
        text
      })
      scope.clear()
      lastCreatedId.current = created.id
      setActiveId(created.id)
      if (withNote) setNoteDraftFor(created.id)
      return created.id
    },
    [selection, index, doc, documentId, engine, bookmarkId, createHighlight]
  )

  // ── Copying the current selection ───────────────────────────────────────
  // Mirrors createFromSelection's text extraction (toGlobal + spansForRange +
  // textForSpans) rather than the simpler `scope.getSelectedText()` used by
  // the dev smoke test, so a copied highlight and a copy-from-selection agree
  // byte-for-byte on what the selection's text actually is.
  // Returns whether the copy actually happened, so the button only shows
  // "Copied" when there was something to confirm.
  const copyFromSelection = useCallback(async (): Promise<boolean> => {
    if (!selection || !index || !doc) return false
    const scope = selection.forDocument(documentId)
    const range = scope.getState().selection
    if (!range) return false

    const a = toGlobal(index, range.start.page, range.start.index)
    const b = toGlobal(index, range.end.page, range.end.index)
    const start = Math.min(a, b)
    const end = Math.max(a, b) + 1

    const text = (await textForSpans(engine, doc, spansForRange(index, start, end))).trim()
    if (!text) return false

    try {
      // The renderer's own document is Karakeep's — always a secure
      // context — so this isn't expected to fail the way it can in the Web
      // pane's arbitrary-page preload. Still shouldn't crash the reader if
      // it does.
      await navigator.clipboard.writeText(text)
    } catch {
      // Nothing more to fall back to here; the button simply won't confirm.
      return false
    }

    // The selection itself is left untouched — copying shouldn't cost the
    // user their selection, any more than it does anywhere else text gets
    // copied. The menu's "Copied" state (SelectionMenu, below) reverts on
    // its own timer; the selection stays live until the user dismisses the
    // menu (click away / Escape) or replaces it with a new one.
    return true
  }, [selection, index, doc, documentId, engine])

  // The page renders as an <img> and the text layer is embedpdf's own
  // selection engine, not a real browser Selection — so the OS's own
  // Cmd/Ctrl+C shortcut has no DOM selection to act on and is otherwise a
  // silent no-op, even with a highlight-toolbar-worthy selection visibly
  // drawn on screen. Wire the shortcut to the same copy path the toolbar
  // button uses.
  useEffect(() => {
    if (!selection || !documentId) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c') return
      // A real DOM selection — text selected inside a note, the AI drawer,
      // or anywhere else with actual selectable text — already has native
      // copy support; don't steal the shortcut from it.
      if (document.getSelection()?.toString()) return
      // Likewise a focused input (the Ask… field): copy means its own text.
      if ((e.target as Element | null)?.closest?.('input, textarea, [contenteditable]')) return
      const scope = selection.forDocument(documentId)
      if (!scope.getState().selection) return
      e.preventDefault()
      void copyFromSelection()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selection, documentId, copyFromSelection])

  const [noteDraftFor, setNoteDraftFor] = useState<string | null>(null)

  // Night mode is a reading preference, not a theme: someone may want a dark
  // app around a paper-white PDF (colour-accurate figures) or a dark PDF in a
  // light app. 'auto' keeps the common case free — it follows the theme until
  // the toggle is touched, and the touch is what makes it explicit.
  const [nightPref, setNightPref] = usePref<NightPref>('pdfNight', 'auto')
  const isDark = useIsDark()
  const night = nightPref === 'auto' ? isDark : nightPref === 'on'

  // ── Whole-document text for Study ───────────────────────────────────────
  // Extraction waits for the text index (pageText is empty until it exists),
  // reuses the per-page cache the highlight anchoring already fills, and is
  // memoised per document so closing and reopening the panel costs nothing.
  const indexRef = useRef(index)
  indexRef.current = index
  const indexingRef = useRef(indexing)
  indexingRef.current = indexing
  const pageTextRef = useRef(pageText)
  pageTextRef.current = pageText
  const currentPageRef = useRef(scrollState.currentPage)
  currentPageRef.current = scrollState.currentPage
  const docStatusRef = useRef(docState?.status)
  docStatusRef.current = docState?.status
  const docRef = useRef(doc)
  docRef.current = doc
  const scrollRef = useRef(scroll)
  scrollRef.current = scroll

  const revealRange = useCallback((page0: number, start?: number, end?: number) => {
    const geo = geometry.current.get(page0)
    const hasRange = start !== undefined && end !== undefined && end > start
    const rect = hasRange && geo ? rectsWithinSlice(geo, start, end - 1)[0] : undefined
    // A distant page would be gone before a smooth scroll arrives, so jump
    // there at once; a near one glides, and the flash starts as it lands.
    const far = Math.abs(page0 + 1 - currentPageRef.current) > 2
    scrollRef.current?.scrollToPage({
      pageNumber: page0 + 1,
      pageCoordinates: rect ? { x: rect.origin.x, y: rect.origin.y } : undefined,
      behavior: far ? 'instant' : 'smooth',
      alignY: 30
    })
    if (refFlashTimer.current) clearTimeout(refFlashTimer.current)
    setRefFlash(null)
    if (!hasRange) return
    const delay = far ? 50 : REF_SCROLL_MS
    refFlashTimer.current = setTimeout(() => {
      setRefFlash({ page: page0, from: start, to: end - 1 })
      refFlashTimer.current = setTimeout(() => setRefFlash(null), REF_FLASH_MS)
    }, delay)
  }, [])
  const revealRangeRef = useRef(revealRange)
  revealRangeRef.current = revealRange

  // ── Region capture ──────────────────────────────────────────────────────
  // The user drags a rectangle over a figure or equation. The drag is in
  // client pixels; it is mapped onto the page it covers most, rendered by the
  // engine (sharp for the display, long side capped) and read for text from
  // the page geometry that anchoring already caches.
  const [capturing, setCapturing] = useState(false)
  const captureResolve = useRef<((a: StudyAttachment | null) => void) | null>(null)
  const engineRef = useRef(engine)
  engineRef.current = engine

  const cancelRegionCapture = useCallback(() => {
    const resolve = captureResolve.current
    captureResolve.current = null
    setCapturing(false)
    resolve?.(null)
  }, [])

  const startRegionCapture = useCallback((): Promise<StudyAttachment | null> => {
    captureResolve.current?.(null)
    return new Promise((resolve) => {
      captureResolve.current = resolve
      setCapturing(true)
    })
  }, [])
  const startRegionCaptureRef = useRef(startRegionCapture)
  startRegionCaptureRef.current = startRegionCapture
  const cancelRegionCaptureRef = useRef(cancelRegionCapture)
  cancelRegionCaptureRef.current = cancelRegionCapture
  useEffect(() => () => cancelRegionCaptureRef.current(), [])

  const finishRegionCapture = useCallback(async (drag: PxRect | null) => {
    const resolve = captureResolve.current
    captureResolve.current = null
    setCapturing(false)
    if (!resolve) return
    try {
      const pdf = docRef.current
      if (!drag || isTinyDrag(drag) || !pdf) return resolve(null)
      const pages: PageBox[] = Array.from(document.querySelectorAll<HTMLElement>('[data-pdf-page]')).flatMap((el) => {
        const page = Number(el.dataset.pdfPage)
        const size = pdf.pages[page]?.size
        if (!Number.isFinite(page) || !size) return []
        const b = el.getBoundingClientRect()
        return [{ page, box: { x: b.left, y: b.top, width: b.width, height: b.height }, pageWidth: size.width }]
      })
      const target = pickPage(drag, pages)
      const area = target && screenToPageRect(drag, target)
      if (!target || !area || isTinyDrag({ width: area.width * area.scale, height: area.height * area.scale })) {
        return resolve(null)
      }
      const pageObj = pdf.pages[target.page]
      const eng = engineRef.current
      // A figure read at a low zoom would be blurry for the model; floor the
      // scale at 1.5 render px per page unit.
      const scaleFactor = renderScaleFor(area.width, area.height, Math.max(area.scale, 1.5), window.devicePixelRatio || 1)
      const blob = await eng
        .renderPageRect(
          pdf,
          pageObj,
          { origin: { x: area.x, y: area.y }, size: { width: area.width, height: area.height } },
          { scaleFactor, dpr: 1, imageType: 'image/png', withAnnotations: true }
        )
        .toPromise()
      const toDataUrl = (b: Blob): Promise<string> =>
        new Promise<string>((ok, fail) => {
          const reader = new FileReader()
          reader.onload = () => ok(String(reader.result))
          reader.onerror = () => fail(reader.error)
          reader.readAsDataURL(b)
        })
      let imageDataUrl = await toDataUrl(blob as Blob)
      // A dense figure can make an enormous PNG: JPEG first, then smaller,
      // the same ladder the web capture uses.
      if (encodedTooLarge(imageDataUrl)) {
        const bitmap = await createImageBitmap(blob as Blob)
        let w = bitmap.width
        let h = bitmap.height
        const canvas = document.createElement('canvas')
        for (let i = 0; i < 4 && encodedTooLarge(imageDataUrl); i++) {
          if (i > 0) {
            w = Math.max(1, Math.round(w / 1.5))
            h = Math.max(1, Math.round(h / 1.5))
          }
          canvas.width = w
          canvas.height = h
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h)
          imageDataUrl = canvas.toDataURL('image/jpeg', 0.85)
        }
        bitmap.close()
        if (encodedTooLarge(imageDataUrl)) return resolve(null)
      }
      let text = ''
      const geo = geometry.current.get(target.page)
      if (geo) {
        const spans = glyphSpansInRect(geo.runs, area).map((sp) => ({ page: target.page, from: sp.from, to: sp.to }))
        try {
          text = tidyRegionText(await textForSpans(eng, pdf, spans))
        } catch {
          text = ''
        }
      }
      const page = target.page + 1
      resolve({
        kind: 'region',
        label: regionLabel(text, page),
        page,
        rect: { x: area.x, y: area.y, width: area.width, height: area.height },
        text: text || undefined,
        imageDataUrl
      })
    } catch {
      resolve(null)
    }
  }, [])

  useEffect(() => {
    if (!onDocumentReader) return
    // One reader per asset, so a result from the previous document's reader
    // is recognisable by its assetId and never taken for this one's.
    const reader = createPdfDocumentReader(
      {
        getIndexProgress: () => indexingRef.current,
        getDocument: () => docRef.current,
        hasIndex: () => !!indexRef.current,
        getPageText: (page) => pageTextRef.current(page),
        getCurrentPage: () => currentPageRef.current,
        reveal: (page0, start, end) => revealRangeRef.current(page0, start, end),
        startRegionCapture: () => startRegionCaptureRef.current(),
        cancelRegionCapture: () => cancelRegionCaptureRef.current(),
        getFailure: () =>
          docStatusRef.current === 'error'
            ? 'The PDF could not be opened'
            : indexFailedRef.current
              ? 'The PDF text could not be read'
              : null
      },
      { assetId }
    )
    onDocumentReader(reader)
    return () => {
      reader.dispose()
      onDocumentReader(null)
    }
  }, [onDocumentReader, assetId])

  // What the selection toolbar's AI actions work from. Unlike a highlight this
  // never clears the selection: the toolbar is attached to it, so the answer
  // has to render inside the same menu while the selection stays alive.
  // Everything the actions need (text, context, offsets, page) is captured
  // here once and held by the menu, so a later selection change cannot
  // desync a save from the text the answer was about.
  const captureSelection = useCallback(
    async (pageIndex: number): Promise<SelectionCapture | null> => {
      if (!selection || !index || !doc) return null
      const scope = selection.forDocument(documentId)
      const range = scope.getState().selection
      if (!range) return null

      const a = toGlobal(index, range.start.page, range.start.index)
      const b = toGlobal(index, range.end.page, range.end.index)
      const start = Math.min(a, b)
      const end = Math.max(a, b) + 1

      const text = (await textForSpans(engine, doc, spansForRange(index, start, end))).trim()
      if (!text) return null

      const ctxStart = Math.max(0, start - 200)
      const ctxEnd = Math.min(index.total, end + 200)
      const surrounding = (await textForSpans(engine, doc, spansForRange(index, ctxStart, ctxEnd))).trim()
      const pageContent = await pageText(pageIndex)

      return {
        selectionText: text,
        surroundingContext: surrounding,
        pageText: pageContent,
        startOffset: start,
        endOffset: end,
        page: range.start.page + 1
      }
    },
    [selection, index, doc, documentId, engine, pageText]
  )

  // The open AI card lives here, not in the selection menu. The selection
  // plugin unmounts and re-mounts its menu as the viewport scrolls (and drops
  // it entirely when the selection leaves the visible pages); state held in
  // the menu would die with it, taking the in-flight answer along. Held at
  // this level the card survives, anchored to the captured page + rect, the
  // way the old floating HUD was. Only an explicit dismissal clears it.
  const [aiCard, setAiCard] = useState<AiCardState | null>(null)
  useEffect(() => {
    setAiCard(null)
  }, [documentId])
  useEffect(() => {
    // Opening an existing highlight replaces the card.
    if (activeId) setAiCard(null)
  }, [activeId])

  const closeAiCard = useCallback((): void => {
    setAiCard(null)
    selection?.forDocument(documentId).clear()
  }, [selection, documentId])

  const saveAiAsHighlight = useCallback(
    async (cap: SelectionCapture, note: string): Promise<void> => {
      const created = await createHighlight.mutateAsync({
        bookmarkId,
        startOffset: cap.startOffset,
        endOffset: cap.endOffset,
        color: DEFAULT_HIGHLIGHT_COLOR,
        text: cap.selectionText,
        note
      })
      setAiCard(null)
      selection?.forDocument(documentId).clear()
      setActiveId(created.id)
    },
    [createHighlight, bookmarkId, selection, documentId]
  )

  // A swatch or Note pressed in the card highlights the captured range, which
  // does not depend on the live selection still existing.
  const createFromCard = useCallback(
    async (cap: SelectionCapture, color: string, withNote: boolean): Promise<void> => {
      const created = await createHighlight.mutateAsync({
        bookmarkId,
        startOffset: cap.startOffset,
        endOffset: cap.endOffset,
        color,
        text: cap.selectionText
      })
      setAiCard(null)
      selection?.forDocument(documentId).clear()
      lastCreatedId.current = created.id
      setActiveId(created.id)
      if (withNote) setNoteDraftFor(created.id)
    },
    [createHighlight, bookmarkId, selection, documentId]
  )

  // Dev smoke only: announce readiness, and on request drive the exact path a
  // user drives — select text in the page, then create a highlight from it.
  const smokeBound = useRef(false)
  useEffect(() => {
    if (!window.kk.dev.isSmoke || !index || !selection || !doc) return
    window.kk.dev.notifyPdfReady()
    // ipcRenderer.on has no removal here, so bind the handlers once.
    if (smokeBound.current) return
    smokeBound.current = true
    window.kk.dev.onPdfHighlight(() => {
      void (async () => {
        try {
        // Drive the *pointer* path, not `setSelection`: a programmatic
        // selection skips the interaction manager entirely, which is how a
        // completely dead text-selection path once passed this test.
        const scope = selection.forDocument(documentId)
        const geo = geometry.current.get(0)
        const pageEl = document.querySelector('[data-pdf-page="0"]')
        console.log(`[smoke-pdf] drag start: geo=${!!geo} pageEl=${!!pageEl}`)
        // Synthetic PointerEvents can never trigger a native image drag, so
        // this bug is invisible to the drag below. Assert the DOM condition
        // that permits it instead.
        const draggable = pageEl
          ? Array.from(pageEl.querySelectorAll('img')).filter((img) => img.draggable)
          : []
        if (draggable.length > 0) {
          console.error(`[smoke-pdf] ${draggable.length} draggable image(s) on the page — native drag will eat the gesture`)
        } else {
          console.log('[smoke-pdf] no natively draggable images on the page')
        }
        if (!geo || !pageEl) {
          window.kk.dev.notifyPdfHighlighted('')
          return
        }
        const box = pageEl.getBoundingClientRect()
        const pageWidth = doc.pages[0]?.size.width || box.width
        const pageScale = box.width / pageWidth
        const upTo = Math.min(40, (index.pageCounts[0] ?? 1) - 1)
        const rects = rectsWithinSlice(geo, 0, upTo)
        const first = rects[0]
        const last = rects[rects.length - 1]
        if (!first || !last) {
          window.kk.dev.notifyPdfHighlighted('')
          return
        }
        // Real-input probe: press and move over the text and see whether the
        // browser starts a native drag. This is the failure a user hits and
        // the one the synthetic drag below cannot see.
        let nativeDrag = false
        const onDragStart = (): void => {
          nativeDrag = true
        }
        pageEl.addEventListener('dragstart', onDragStart)
        await window.kk.dev.realInputOnPdf({
          x: box.left + (first.origin.x + 4) * pageScale,
          y: box.top + (first.origin.y + first.size.height / 2) * pageScale
        })
        pageEl.removeEventListener('dragstart', onDragStart)
        if (nativeDrag) {
          console.error('[smoke-pdf] real input started a NATIVE DRAG — text selection is broken')
          window.kk.dev.notifyPdfHighlighted('')
          return
        }
        console.log('[smoke-pdf] real input did not start a native drag')
        scope.clear()

        const drag = {
          x1: box.left + (first.origin.x + 1) * pageScale,
          y1: box.top + (first.origin.y + first.size.height / 2) * pageScale,
          x2: box.left + (last.origin.x + last.size.width - 1) * pageScale,
          y2: box.top + (last.origin.y + last.size.height / 2) * pageScale
        }

        // Dispatch the drag as real DOM pointer events on the page element.
        // Driving it from the main process instead (sendInputEvent, or the
        // debugger's Input domain) looks more realistic but is useless here:
        // Chromium coalesced twelve synthesized moves down to one, so the
        // selection never got past the anchor glyph. These land one for one
        // on the very listeners the interaction manager registers.
        const dispatch = (type: string, x: number, y: number, buttons: number): void => {
          pageEl.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              button: 0,
              buttons,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true
            })
          )
        }
        dispatch('pointerdown', drag.x1, drag.y1, 1)
        const steps = 12
        for (let i = 1; i <= steps; i++) {
          dispatch(
            'pointermove',
            drag.x1 + ((drag.x2 - drag.x1) * i) / steps,
            drag.y1 + ((drag.y2 - drag.y1) * i) / steps,
            1
          )
          await new Promise((r) => setTimeout(r, 10))
        }
        dispatch('pointerup', drag.x2, drag.y2, 0)
        await new Promise((r) => setTimeout(r, 200))
        console.log(`[smoke-pdf] dispatched drag ${JSON.stringify(drag)}; selection=${!!scope.getState().selection}`)
        if (!scope.getState().selection) {
          console.error('[smoke-pdf] no selection after drag')
          window.kk.dev.notifyPdfHighlighted('')
          return
        }

        const picked = (await scope.getSelectedText().toPromise()).join('')
        console.log(`[smoke-pdf] drag selected ${picked.length} chars: ${JSON.stringify(picked.slice(0, 80))}`)
        if (picked.length <= 1) {
          console.error('[smoke-pdf] drag did not extend the selection')
          window.kk.dev.notifyPdfHighlighted('')
          return
        }
        if (!scope.getState().selection) {
          console.error('[smoke-pdf] pointer drag produced no selection')
          window.kk.dev.notifyPdfHighlighted('')
          return
        }
        // Quick AI, driven the same way a user would: a real click on the
        // toolbar's Explain button, on the selection the drag above made.
        // The answer opens inside the same toolbar card; the toolbar must
        // stay put (no click-through dismissal) and the selection must
        // survive so the swatch flow below still works.
        const askAiBtn = document.querySelector<HTMLElement>('[data-kk-ai-mode="micro-explain"]')
        if (!askAiBtn) {
          console.error('[smoke-pdf] selection toolbar has no Explain button')
        } else {
          const askAiBox = askAiBtn.getBoundingClientRect()
          await window.kk.dev.realClickOnPdf({
            x: askAiBox.left + askAiBox.width / 2,
            y: askAiBox.top + askAiBox.height / 2
          })
          await new Promise((r2) => setTimeout(r2, 400))
          const card = document.querySelector<HTMLElement>('[data-kk-inline-answer]')
          if (!card) {
            console.error('[smoke-pdf] inline answer did not open after clicking Explain')
          } else {
            const cs = getComputedStyle(card)
            console.log(`[smoke-pdf] inline answer opened; computed pointer-events=${cs.pointerEvents}`)
            if (cs.pointerEvents === 'none') {
              console.error('[smoke-pdf] inline answer is not hit-testable (pointer-events: none)')
            }
          }
          // Dismiss the way a user would (Escape) and confirm it closes,
          // then restore the selection for the swatch flow below — closing
          // the toolbar clears the selection.
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await new Promise((r2) => setTimeout(r2, 250))
          if (document.querySelector('[data-kk-inline-answer]')) {
            console.error('[smoke-pdf] inline answer did not dismiss on Escape')
          } else {
            console.log('[smoke-pdf] inline answer dismissed on Escape')
          }
          // KK_SMOKE_AI_ONLY stops here, before the swatch click below ever
          // runs — that click creates a highlight, and this mode exists to
          // verify the inline answer against a bookmark that write-testing isn't
          // scoped to.
          if (window.kk.dev.smokeAiOnly) {
            console.log('[smoke-pdf] KK_SMOKE_AI_ONLY=1 — stopping before highlight creation')
            window.kk.dev.notifyPdfHighlighted('')
            return
          }
          dispatch('pointerdown', drag.x1, drag.y1, 1)
          for (let i = 1; i <= steps; i++) {
            dispatch(
              'pointermove',
              drag.x1 + ((drag.x2 - drag.x1) * i) / steps,
              drag.y1 + ((drag.y2 - drag.y1) * i) / steps,
              1
            )
            await new Promise((r2) => setTimeout(r2, 10))
          }
          dispatch('pointerup', drag.x2, drag.y2, 0)
          await new Promise((r2) => setTimeout(r2, 200))
        }

        // Click the toolbar the way a user does. Calling createFromSelection()
        // directly here is what let a completely unclickable toolbar pass:
        // the press has to travel through the same listeners the page binds.
        const swatch = document.querySelector<HTMLElement>('[data-kk-swatch="yellow"]')
        const noteButton = document.querySelector<HTMLElement>('[data-kk-note]')
        if (!swatch || !noteButton) {
          console.error('[smoke-pdf] selection toolbar did not appear after the drag')
          window.kk.dev.notifyPdfHighlighted('')
          return
        }
        lastCreatedId.current = null
        // Click the swatch with real OS-level input at its own coordinates.
        // Synthetic events are not good enough here: a press that a user makes
        // reaches the page's native listeners exactly as the browser routes
        // it, which is the whole question.
        const swatchBox = swatch.getBoundingClientRect()
        await window.kk.dev.realClickOnPdf({
          x: swatchBox.left + swatchBox.width / 2,
          y: swatchBox.top + swatchBox.height / 2
        })
        // The click has to survive: if the press cleared the selection, the
        // toolbar unmounts and nothing is ever created.
        for (let i = 0; i < 40 && !lastCreatedId.current; i++) {
          await new Promise((r) => setTimeout(r, 100))
        }
        const id = lastCreatedId.current
        if (!id) {
          console.error(
            '[smoke-pdf] toolbar click produced no highlight — the press was swallowed ' +
              `(toolbar still mounted: ${document.contains(swatch)}, selection alive: ${!!scope.getState().selection})`
          )
          window.kk.dev.notifyPdfHighlighted('')
          return
        }
        console.log('[smoke-pdf] toolbar click created a highlight')
        await updateHighlight.mutateAsync({ id, input: { note: 'smoke note' }, bookmarkId })

        // The popover has to be *painted* and reachable, not merely mounted.
        // The version before this one compiled its background away entirely
        // (a Tailwind opacity step outside the scale silently produces no
        // rule at all) and stayed invisible while still hit-testing — a state
        // no assertion about React output would have caught.
        await new Promise((r) => setTimeout(r, 500))
        const popEl = (): HTMLElement | null => document.querySelector<HTMLElement>('.kh-pop')
        const pop = popEl()
        if (!pop) {
          console.error('[smoke-pdf] highlight popover did not open after creating a highlight')
        } else {
          // One highlight, one popover. Every mounted page used to render a
          // copy of the active highlight's popover, and the pages that don't
          // contain it have nothing to anchor against — so a second, unplaced
          // copy sat in the corner of the window.
          const all = document.querySelectorAll<HTMLElement>('.kh-pop')
          if (all.length !== 1) {
            console.error(`[smoke-pdf] ${all.length} popovers in the DOM — expected exactly one`)
          } else {
            console.log('[smoke-pdf] exactly one popover in the DOM')
          }

          const bg = getComputedStyle(pop).backgroundColor
          const alpha = Number(/rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec(bg)?.[1] ?? '1')
          if (alpha < 0.5) console.error(`[smoke-pdf] popover background is transparent: ${bg}`)
          else console.log(`[smoke-pdf] popover background ${bg}`)

          const r = pop.getBoundingClientRect()
          const onScreen =
            r.width > 4 &&
            r.height > 4 &&
            r.left >= 0 &&
            r.top >= 0 &&
            r.right <= window.innerWidth &&
            r.bottom <= window.innerHeight
          if (!onScreen) console.error(`[smoke-pdf] popover is not fully on screen: ${JSON.stringify(r)}`)
          else console.log('[smoke-pdf] popover is fully on screen')

          // A press anywhere else must dismiss it.
          await window.kk.dev.realClickOnPdf({
            x: Math.min(box.left + box.width * 0.5, window.innerWidth - 12),
            y: Math.min(box.top + box.height * 0.92, window.innerHeight - 12)
          })
          await new Promise((r2) => setTimeout(r2, 350))
          if (popEl()) console.error('[smoke-pdf] popover survived a press outside it')
          else console.log('[smoke-pdf] popover dismissed on outside press')

          // And pressing the highlight itself must bring it back.
          const mark = document.querySelector<HTMLElement>(`[data-kk-mark="${id}"]`)
          if (!mark) {
            console.error('[smoke-pdf] no mark rendered for the new highlight')
          } else {
            const mr = mark.getBoundingClientRect()
            await window.kk.dev.realClickOnPdf({ x: mr.left + mr.width / 2, y: mr.top + mr.height / 2 })
            await new Promise((r2) => setTimeout(r2, 350))
            if (popEl()) console.log('[smoke-pdf] press on the highlight reopened its popover')
            else console.error('[smoke-pdf] press on the highlight did not reopen its popover')
          }
        }
        window.kk.dev.notifyPdfHighlighted(id)
        } catch (err) {
          // Never leave the driver waiting on a promise that already failed.
          console.error(`[smoke-pdf] drag step threw: ${err instanceof Error ? err.message : String(err)}`)
          window.kk.dev.notifyPdfHighlighted('')
        }
      })()
    })
    window.kk.dev.onPdfCleanup((id: string) => {
      void deleteHighlight.mutateAsync({ id, bookmarkId }).then(
        () => window.kk.dev.notifyPdfCleaned(true),
        () => window.kk.dev.notifyPdfCleaned(false)
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, selection, doc])

  const renderPage = useCallback(
    (layout: PageLayout) => (
      <PdfPage
        key={layout.pageIndex}
        pageIndex={layout.pageIndex}
        scale={scaleFor(doc, layout)}
        documentId={documentId}
        placed={placed}
        geometry={geometry.current}
        activeId={activeId}
        flashId={flashId}
        refFlash={refFlash}
        noteDraftFor={noteDraftFor}
        night={night}
        onActivate={(id) => {
          setActiveId(id)
          setNoteDraftFor(null)
        }}
        onDismiss={() => {
          setActiveId(null)
          setNoteDraftFor(null)
        }}
        onEditNote={(id) => setNoteDraftFor(id)}
        onSaveNote={async (id, note) => {
          await updateHighlight.mutateAsync({ id, input: { note }, bookmarkId })
          setNoteDraftFor(null)
        }}
        onRecolor={async (id, color) => {
          await updateHighlight.mutateAsync({ id, input: { color }, bookmarkId })
        }}
        onDelete={async (id) => {
          setActiveId(null)
          setNoteDraftFor(null)
          await deleteHighlight.mutateAsync({ id, bookmarkId })
        }}
        onCreate={createFromSelection}
        onCopy={copyFromSelection}
        onCapture={captureSelection}
        onOpenCard={setAiCard}
        cardOpen={!!aiCard}
        onStudyAttach={onStudyAttach}
      />
    ),
    [
      doc,
      documentId,
      placed,
      activeId,
      flashId,
      refFlash,
      noteDraftFor,
      night,
      updateHighlight,
      deleteHighlight,
      bookmarkId,
      createFromSelection,
      copyFromSelection,
      captureSelection,
      aiCard,
      onStudyAttach
    ]
  )

  const highlightCount = placed.filter((p) => p.quality !== 'missing').length

  return (
    <>
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-white px-3 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900">
        <button
          type="button"
          onClick={() => scroll?.scrollToPreviousPage()}
          className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800"
          disabled={scrollState.currentPage <= 1}
          aria-label="Previous page"
        >
          ↑
        </button>
        <span className="tabular-nums text-neutral-500">
          {scrollState.currentPage} / {totalPages || '—'}
        </span>
        <button
          type="button"
          onClick={() => scroll?.scrollToNextPage()}
          className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800"
          disabled={totalPages > 0 && scrollState.currentPage >= totalPages}
          aria-label="Next page"
        >
          ↓
        </button>

        <span className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-800" />

        <button
          type="button"
          onClick={() => zoom?.zoomOut()}
          className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="w-10 text-center tabular-nums text-neutral-500">
          {Math.round((zoomState?.currentZoomLevel ?? 1) * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoom?.zoomIn()}
          className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => zoom?.requestZoom(ZoomMode.FitWidth)}
          className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          Fit
        </button>

        <button
          type="button"
          onClick={() => setNightPref(night ? 'off' : 'on')}
          className={`rounded px-1.5 py-0.5 transition-colors ${
            night
              ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
              : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800'
          }`}
          title={night ? 'Night mode on — click for the original page' : 'Night mode (invert page for dark reading)'}
          aria-pressed={night}
          aria-label="Toggle night mode"
        >
          {night ? '☾' : '☀'}
        </button>

        {/* No Co-Pilot button here. It lives in the detail pane's utility
            bar alongside highlights, favourite and archive, so the same
            controls are in the same place whether you're reading a PDF or
            a live page. This bar is only for what's specific to a PDF. */}

        <div className="ml-auto text-neutral-400">
          {indexing
            ? `Indexing text ${indexing.done}/${indexing.total}`
            : highlightCount > 0
              ? `${highlightCount} highlight${highlightCount === 1 ? '' : 's'}`
              : 'Select text to highlight or Ask AI'}
        </div>
      </div>

      {/* `min-w-0` on both, and it is load-bearing. A flex item defaults to
          `min-width: auto`, which is the *content's* min-content width — and
          a laid-out PDF page is a fixed pixel width, so this column simply
          refused to shrink when a side pane opened. The page kept its width
          and slid under the pane (clipped by `overflow-hidden`), which also
          meant the viewport element never resized, so the zoom plugin's
          resize observer never fired and FitWidth never re-fitted.
          No `h-full` on the row either: it sits under the toolbar in a
          column, so a full-height row overflows the pane by the toolbar's
          height — `flex-1` is the height that's actually left. */}
      {findOpen && (
        <FindBar
          result={findResult}
          focusSignal={findFocusSignal}
          onQuery={(q) => void search?.searchAllPages(q)}
          onNext={() => search?.nextResult()}
          onPrevious={() => search?.previousResult()}
          onClose={onFindClose}
        />
      )}

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div ref={pinchHostRef} className="relative h-full min-h-0 min-w-0 flex-1">
          <Viewport
            documentId={documentId}
            className={`h-full w-full overflow-auto ${
              night ? 'bg-neutral-950' : 'bg-neutral-100 dark:bg-neutral-950'
            }`}
          >
            {/* The interaction manager only sees pointer events that come
                through its providers — without them the selection plugin never
                gets a pointer-down and text cannot be selected at all. */}
            <GlobalPointerProvider documentId={documentId}>
              <Scroller documentId={documentId} renderPage={renderPage} />
            </GlobalPointerProvider>
          </Viewport>
          {capturing && (
            <RegionCaptureOverlay
              onDone={(r) => void finishRegionCapture(r)}
              onCancel={cancelRegionCapture}
              scrollHost={pinchHostRef.current?.firstElementChild ?? null}
            />
          )}
        </div>

      </div>

      {aiCard && (
        <AiCard
          card={aiCard}
          onChange={setAiCard}
          onClose={closeAiCard}
          onCreate={(color, withNote) => createFromCard(aiCard.cap, color, withNote)}
          onSaveAiNote={(note) => saveAiAsHighlight(aiCard.cap, note)}
          onStudyAttach={onStudyAttach}
          onStudyContinue={onStudyContinue}
          docTitle={title || fileName}
          sourceUrl={sourceUrl}
          author={author}
        />
      )}
    </>
  )
}

/** Crosshair over the page area: drag a rectangle, Esc or a tiny drag cancels. */
function RegionCaptureOverlay({
  onDone,
  onCancel,
  scrollHost
}: {
  onDone: (drag: PxRect) => void
  onCancel: () => void
  scrollHost: Element | null
}): React.JSX.Element {
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; rect: PxRect } | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  // The overlay sits above the viewport, so the wheel has to be handed on to
  // keep the document scrollable while aiming.
  useEffect(() => {
    const el = hostRef.current
    if (!el || !scrollHost) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      scrollHost.scrollBy({ left: e.deltaX, top: e.deltaY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scrollHost])

  const bounds = (): DOMRect | undefined => hostRef.current?.getBoundingClientRect()

  return (
    <div
      ref={hostRef}
      data-testid="region-capture-overlay"
      className="absolute inset-0 z-30 select-none bg-black/10"
      style={{ cursor: 'crosshair', touchAction: 'none' }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag({ from: { x: e.clientX, y: e.clientY }, rect: rectFromPoints(e.clientX, e.clientY, e.clientX, e.clientY) })
      }}
      onPointerMove={(e) => {
        if (drag) setDrag({ from: drag.from, rect: rectFromPoints(drag.from.x, drag.from.y, e.clientX, e.clientY) })
      }}
      onPointerUp={(e) => {
        if (!drag) return
        const rect = rectFromPoints(drag.from.x, drag.from.y, e.clientX, e.clientY)
        setDrag(null)
        if (isTinyDrag(rect)) onCancel()
        else onDone(rect)
      }}
      onPointerCancel={onCancel}
    >
      <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-neutral-900/80 px-2.5 py-1 text-xs text-neutral-100">
        Drag over a figure or equation. Esc to cancel.
      </div>
      {drag && (
        <div
          className="pointer-events-none absolute rounded-sm border-[1.5px] border-emerald-500 bg-emerald-500/15"
          style={{
            left: drag.rect.x - (bounds()?.left ?? 0),
            top: drag.rect.y - (bounds()?.top ?? 0),
            width: drag.rect.width,
            height: drag.rect.height
          }}
        />
      )}
    </div>
  )
}

/** The expanded AI card: the captured selection plus what is being shown for it. */
interface AiCardState {
  cap: SelectionCapture
  /** Where the card is anchored: page-relative rect on `pageIndex`. */
  rect: Rect
  pageIndex: number
  view: { mode: InlineMode; prompt?: string } | null
  asking: boolean
}

function anchorForPageRect(pageIndex: number, rect: Rect): DOMRect | null {
  const pageEl = document.querySelector(`[data-pdf-page="${pageIndex}"]`)
  if (!pageEl) return null
  const box = pageEl.getBoundingClientRect()
  return new DOMRect(box.left + rect.origin.x, box.top + rect.origin.y, rect.size.width, rect.size.height)
}

/** What the toolbar's AI actions read from the live selection (see captureSelection). */
interface SelectionCapture {
  selectionText: string
  surroundingContext: string
  pageText: string
  startOffset: number
  endOffset: number
  /** 1-based, the page the selection starts on. */
  page: number
}

interface PdfPageProps {
  pageIndex: number
  scale: number
  documentId: string
  placed: PlacedHighlight[]
  geometry: Map<number, PdfPageGeometry>
  activeId: string | null
  flashId: string | null
  refFlash: { page: number; from: number; to: number } | null
  noteDraftFor: string | null
  /** Inverts the page bitmap and re-blends highlights for dark reading. */
  night: boolean
  onActivate: (id: string) => void
  onDismiss: () => void
  onEditNote: (id: string) => void
  onSaveNote: (id: string, note: string) => Promise<void>
  onRecolor: (id: string, color: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onCreate: (color: string, withNote: boolean) => Promise<string | null>
  onCopy: () => Promise<boolean>
  onCapture: (pageIndex: number) => Promise<SelectionCapture | null>
  onOpenCard: (card: AiCardState) => void
  cardOpen: boolean
  onStudyAttach?: (attachment: StudyAttachment) => void
}

function PdfPage({
  pageIndex,
  scale,
  documentId,
  placed,
  geometry,
  activeId,
  flashId,
  refFlash,
  noteDraftFor,
  night,
  onActivate,
  onDismiss,
  onEditNote,
  onSaveNote,
  onRecolor,
  onDelete,
  onCreate,
  onCopy,
  onCapture,
  onOpenCard,
  cardOpen,
  onStudyAttach
}: PdfPageProps): React.JSX.Element {
  const geo = geometry.get(pageIndex)

  // Rects live in unscaled page coordinates; the overlay is laid over the
  // rendered page, so everything is multiplied up by the current scale.
  const marks = useMemo(() => {
    if (!geo) return []
    return placed.flatMap(({ highlight, spans }) =>
      spans
        .filter((s) => s.page === pageIndex)
        .flatMap((s) =>
          rectsWithinSlice(geo, s.from, s.to).map((rect) => ({ highlight, rect }))
        )
    )
  }, [geo, placed, pageIndex])

  const refFlashRects = useMemo(
    () => (geo && refFlash && refFlash.page === pageIndex ? rectsWithinSlice(geo, refFlash.from, refFlash.to) : []),
    [geo, refFlash, pageIndex]
  )

  // Only the page the highlight starts on draws its popover. `placed` is
  // document-wide, so without this every mounted page rendered one — and the
  // pages that don't contain the highlight have no anchor to place it
  // against, leaving a second copy stranded in the corner of the window.
  const active = placed.find(
    (p) =>
      p.highlight.id === activeId &&
      p.spans.length > 0 &&
      Math.min(...p.spans.map((s) => s.page)) === pageIndex
  )

  /**
   * The popover anchors to the whole highlight, not to its first line: a
   * three-line highlight anchored to line one puts the popover in the middle
   * of its own text. Union of every rect this highlight has on this page,
   * converted to viewport coordinates for `placePopover`.
   */
  const activeAnchor = useCallback((): DOMRect | null => {
    if (!active) return null
    const own = marks.filter((m) => m.highlight.id === active.highlight.id)
    if (own.length === 0) return null
    const pageEl = document.querySelector(`[data-pdf-page="${pageIndex}"]`)
    if (!pageEl) return null
    const box = pageEl.getBoundingClientRect()
    const left = Math.min(...own.map((m) => m.rect.origin.x)) * scale
    const top = Math.min(...own.map((m) => m.rect.origin.y)) * scale
    const right = Math.max(...own.map((m) => m.rect.origin.x + m.rect.size.width)) * scale
    const bottom = Math.max(...own.map((m) => m.rect.origin.y + m.rect.size.height)) * scale
    return new DOMRect(box.left + left, box.top + top, right - left, bottom - top)
  }, [active, marks, pageIndex, scale])

  return (
    <PagePointerProvider
      documentId={documentId}
      pageIndex={pageIndex}
      // Explicit: the provider otherwise converts client coordinates to page
      // coordinates with the *document* scale, which is not the scale the
      // zoom plugin actually laid this page out at. A mismatch puts every
      // point a few percent off — enough that hit-testing lands between
      // glyphs and a drag stops extending the selection.
      scale={scale}
      data-pdf-page={pageIndex}
      // A page renders as an <img>, and Chromium drags images natively: press
      // and move and you get a drag-and-drop of the page picture instead of a
      // text selection. Worse, the drag swallows the rest of the pointer
      // stream, so the selection plugin never sees pointerup — it stays in
      // "selecting" state, follows the cursor with no button held, and never
      // finalises, which is why no highlight toolbar ever appeared. Cancel it
      // here, at the container, so it stays cancelled for anything the page
      // renders.
      onDragStart={(e) => e.preventDefault()}
      className="relative h-full w-full select-none"
    >
      <RenderLayer
        documentId={documentId}
        pageIndex={pageIndex}
        draggable={false}
        style={{ position: 'absolute', filter: night ? NIGHT_FILTER : undefined }}
      />

      {/* Stored highlights, under the text layer so selection still works. */}
      <div className="pointer-events-none absolute inset-0">
        {marks.map(({ highlight, rect }, i) => (
          <div
            key={`${highlight.id}-${i}`}
            onClick={() => onActivate(highlight.id)}
            title={highlight.note || undefined}
            // Marks the popover's outside-press check looks for: pressing one
            // highlight while another's popover is open should switch to it,
            // not merely dismiss.
            data-kk-mark={highlight.id}
            className={`pointer-events-auto cursor-pointer transition-[opacity,box-shadow] ${
              flashId === highlight.id ? 'animate-pulse' : ''
            }`}
            style={{
              position: 'absolute',
              left: rect.origin.x * scale,
              top: rect.origin.y * scale,
              width: rect.size.width * scale,
              height: rect.size.height * scale,
              backgroundColor: hexForColor(highlight.color),
              // The marks sit *outside* the filtered image, so they blend
              // against pixels that are already inverted. Multiply darkens,
              // which on a night-mode page means a highlight would erase the
              // text it is meant to mark; screen is its complement and tints
              // the same colour upwards instead.
              opacity: night
                ? activeId === highlight.id
                  ? 0.34
                  : 0.2
                : activeId === highlight.id
                  ? 0.55
                  : 0.32,
              mixBlendMode: night ? 'screen' : 'multiply',
              borderBottom: highlight.note ? `2px solid ${hexForColor(highlight.color)}` : undefined
            }}
          />
        ))}
      </div>

      {/* A passage Study pointed at: yellow and pulsing like a focused
          highlight, but only an overlay — it is not a highlight. */}
      {refFlashRects.length > 0 && (
        <div className="pointer-events-none absolute inset-0" data-kk-ref-flash>
          {refFlashRects.map((rect, i) => (
            <div
              key={i}
              className="animate-pulse"
              style={{
                position: 'absolute',
                left: rect.origin.x * scale,
                top: rect.origin.y * scale,
                width: rect.size.width * scale,
                height: rect.size.height * scale,
                backgroundColor: '#FFE066',
                opacity: night ? 0.34 : 0.6,
                mixBlendMode: night ? 'screen' : 'multiply'
              }}
            />
          ))}
        </div>
      )}

      {/* Find matches: all in a pale yellow, the current one in orange so it
          reads as "you are here". Under the text layer, like the stored
          highlights, so selecting text still works over a match. */}
      <SearchLayer
        documentId={documentId}
        pageIndex={pageIndex}
        scale={scale}
        highlightColor={night ? '#8A7300' : '#FFE066'}
        activeHighlightColor="#FF8A00"
        className="absolute inset-0"
        // The layer hard-codes `multiply` on every rect, which on a night-mode
        // (inverted, near-black) page darkens the colour to nothing. A blend
        // mode on the wrapper makes it an isolated group: the rects multiply
        // against a transparent backdrop (so keep their own colour), and the
        // group as a whole is then screened onto the page — the same trick the
        // stored highlights use, here without the per-rect control.
        style={night ? { mixBlendMode: 'screen' } : undefined}
      />

      <SelectionLayer
        documentId={documentId}
        pageIndex={pageIndex}
        scale={scale}
        selectionMenu={(menu: SelectionSelectionMenuProps) =>
          menu.selected ? (
            <SelectionMenu
              rect={menu.rect}
              pageIndex={pageIndex}
              onCreate={onCreate}
              onCopy={onCopy}
              onCapture={() => onCapture(pageIndex)}
              onOpenCard={onOpenCard}
              cardOpen={cardOpen}
              onStudyAttach={onStudyAttach}
            />
          ) : null
        }
      />

      {active && (
        <HighlightPopover
          highlight={active.highlight}
          anchor={activeAnchor}
          editingNote={noteDraftFor === active.highlight.id}
          onEditNote={() => onEditNote(active.highlight.id)}
          onSaveNote={(note) => onSaveNote(active.highlight.id, note)}
          onRecolor={(color) => onRecolor(active.highlight.id, color)}
          onDelete={() => onDelete(active.highlight.id)}
          onDismiss={onDismiss}
        />
      )}
    </PagePointerProvider>
  )
}

// ───────────────────────── floating UI ─────────────────────────

/**
 * A popover in viewport coordinates, portalled to the document.
 *
 * Rendering it in the page's own tree was the source of two bugs at once. It
 * inherited the page's stacking and clipping, so a popover near the bottom of
 * a page was cut off with nowhere to flip to; and it sat inside the
 * interaction manager's providers, where the selection plugin's own
 * pointer-down handler could clear the selection out from under a press meant
 * for a button. Out here it is a sibling of the viewport: nothing clips it,
 * and page handlers never see its events at all.
 *
 * Position is recomputed every render (the popover changes size when it swaps
 * between reading a note and editing one) and on scroll and resize, since the
 * anchor is a moving target inside a scrolling viewport.
 */
function FloatingPopover({
  anchor,
  className,
  onDismiss,
  children
}: {
  anchor: () => DOMRect | null
  className?: string
  onDismiss?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const [host] = useState(() => document.createElement('div'))
  const el = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // pointer-events: none so the host never swallows clicks meant for the
    // page; the popover itself opts back in (`.kh-pop`).
    host.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;'
    document.body.appendChild(host)
    return () => host.remove()
  }, [host])

  useLayoutEffect(() => {
    const place = (): void => {
      if (!el.current) return
      const rect = anchor()
      // An unplaceable popover is hidden rather than left at the top-left
      // corner, which is where a `fixed` element with no coordinates lands.
      el.current.style.visibility = rect ? 'visible' : 'hidden'
      if (rect) placePopover(el.current, rect)
    }
    place()

    let frame = 0
    const queue = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        place()
      })
    }
    window.addEventListener('scroll', queue, true)
    window.addEventListener('resize', queue)
    // The popover also changes size on its own: a streamed answer grows the
    // card from a child that FloatingPopover never re-renders for. Re-place
    // whenever the box changes so it neither slides over the selection nor
    // pushes its footer off-screen.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(queue)
    if (el.current) ro?.observe(el.current)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      ro?.disconnect()
      window.removeEventListener('scroll', queue, true)
      window.removeEventListener('resize', queue)
    }
  })

  useEffect(() => {
    if (!onDismiss) return
    const onDown = (e: PointerEvent): void => {
      if (el.current && e.composedPath().includes(el.current)) return
      // A press on another highlight opens that one instead; letting this
      // dismissal run first would just make it a two-click affair.
      if ((e.target as Element)?.closest?.('[data-kk-mark]')) return
      onDismiss()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onDismiss])

  return createPortal(
    <div
      ref={el}
      // The interaction manager's own opt-out. Redundant now that the popover
      // lives outside its providers, and kept deliberately: it costs nothing
      // and it is the documented way to say "this is not page surface".
      data-no-interaction
      className={className ? `kh-pop ${className}` : 'kh-pop'}
      onPointerDown={(e) => {
        // Don't let a press on the toolbar drop the selection it was opened
        // for — except in the fields that own their own selection.
        if (!(e.target as HTMLElement).closest('.kh-ta, .kh-note-view, .kh-input, .kh-ans')) e.preventDefault()
      }}
    >
      {children}
    </div>,
    host
  )
}

function Icon({ path }: { path: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  )
}

function PopButton({
  label,
  icon,
  onClick,
  danger,
  iconOnly,
  primary,
  disabled,
  // The set of labels this button ever shows (e.g. ['Copy', 'Copied']).
  // When given, all of them are stacked so the button's width is pinned to
  // the widest one from the start — see the .kh-btn-label-stack rule in
  // highlightUi.ts for why that's what stops the popover from jumping.
  reserveLabels,
  ...rest
}: {
  label: string
  icon?: string
  onClick: () => void
  danger?: boolean
  iconOnly?: boolean
  primary?: boolean
  disabled?: boolean
  reserveLabels?: string[]
} & React.HTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-danger={danger ? '1' : undefined}
      className={`kh-btn${iconOnly ? ' kh-icon-only' : ''}${primary ? ' kh-primary' : ''}`}
      title={iconOnly ? label : undefined}
      aria-label={iconOnly ? label : undefined}
      {...rest}
    >
      {icon && <Icon path={icon} />}
      {!iconOnly &&
        (reserveLabels ? (
          <span className="kh-btn-label-stack">
            {reserveLabels.map((l) => (
              <span key={l} data-shown={l === label ? '1' : undefined}>
                {l}
              </span>
            ))}
          </span>
        ) : (
          <span>{label}</span>
        ))}
    </button>
  )
}

/** The colour row, shared by the selection toolbar and the highlight editor. */
function SwatchRow({
  active,
  disabled,
  onPick
}: {
  active: string | null
  disabled?: boolean
  onPick: (color: string) => void
}): React.JSX.Element {
  return (
    <div className="kh-row">
      {COLORS.map((c) => (
        <button
          key={c.name}
          type="button"
          disabled={disabled}
          onClick={() => onPick(c.name)}
          data-kk-swatch={c.name}
          data-active={active === c.name ? '1' : undefined}
          title={c.name[0].toUpperCase() + c.name.slice(1)}
          aria-label={c.name[0].toUpperCase() + c.name.slice(1)}
          className="kh-swatch"
          style={{ backgroundColor: c.hex }}
        >
          {active === c.name && (
            <svg viewBox="0 0 24 24" fill="none" stroke="rgba(0,0,0,0.65)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
              <path d={ICON_CHECK} />
            </svg>
          )}
        </button>
      ))}
    </div>
  )
}

const QUICK_ACTIONS: { mode: Exclude<InlineMode, 'custom'>; label: string }[] = [
  { mode: 'micro-explain', label: 'Explain' },
  { mode: 'micro-define', label: 'Define' },
  { mode: 'micro-formula', label: 'Math' }
]

/**
 * The toolbar row shared by the selection menu and the expanded AI card:
 * colours, Note, Copy, then Explain / Define / Math / Ask… and Add to Study.
 */
function SelectionToolbar({
  busy,
  activeMode,
  asking,
  onSwatch,
  onNote,
  onCopy,
  onMode,
  onAsk,
  onAttach
}: {
  busy: boolean
  activeMode: InlineMode | null
  asking: boolean
  onSwatch: (color: string) => void
  onNote: () => void
  onCopy: () => Promise<boolean>
  onMode: (mode: Exclude<InlineMode, 'custom'>) => void
  onAsk: () => void
  onAttach?: () => void
}): React.JSX.Element {
  // Copying leaves the selection and menu alone (see copyFromSelection). This
  // flag only drives the button's "Copied" label and reverts itself after
  // COPY_CONFIRM_MS; the cleanup matters if the menu unmounts mid-confirmation.
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPY_CONFIRM_MS)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="kh-toolbar">
      <SwatchRow active={null} disabled={busy} onPick={onSwatch} />
      <div className="kh-sep" />
      <PopButton label="Note" icon={ICON_NOTE} disabled={busy} onClick={onNote} data-kk-note="" />
      {/* Copy sits right next to Note, mirroring where it lands on an
          existing highlight's popover (HighlightPopover below). */}
      <PopButton
        label={copied ? 'Copied' : 'Copy'}
        reserveLabels={['Copy', 'Copied']}
        icon={copied ? ICON_CHECK : ICON_COPY}
        disabled={busy || copied}
        onClick={() => {
          void (async () => {
            // Only confirm if the copy actually happened.
            if (await onCopy()) setCopied(true)
          })()
        }}
        data-kk-copy=""
      />
      <div className="kh-sep" />
      {QUICK_ACTIONS.map((a) => (
        <PopButton
          key={a.mode}
          label={a.label}
          disabled={busy}
          data-on={activeMode === a.mode ? '1' : undefined}
          onClick={() => onMode(a.mode)}
          data-kk-ai-mode={a.mode}
        />
      ))}
      <PopButton
        label="Ask…"
        disabled={busy}
        data-on={asking || activeMode === 'custom' ? '1' : undefined}
        onClick={onAsk}
        data-kk-ai-mode="custom"
      />
      {onAttach && (
        <PopButton
          label="Add to Study"
          icon={ICON_STUDY_ATTACH}
          iconOnly
          disabled={busy}
          onClick={onAttach}
          data-kk-study-attach=""
        />
      )}
    </div>
  )
}

/**
 * The plain toolbar shown against a live text selection. Choosing an AI
 * action hands over to the AiCard (held by PdfSurface, so it outlives this
 * menu); while that card is open this menu steps aside.
 */
function SelectionMenu({
  rect,
  pageIndex,
  cardOpen,
  onCreate,
  onCopy,
  onCapture,
  onOpenCard,
  onStudyAttach
}: {
  rect: Rect
  pageIndex: number
  cardOpen: boolean
  onCreate: (color: string, withNote: boolean) => Promise<string | null>
  onCopy?: () => Promise<boolean>
  onCapture: () => Promise<SelectionCapture | null>
  onOpenCard: (card: AiCardState) => void
  onStudyAttach?: (attachment: StudyAttachment) => void
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)

  // `rect` is page-relative and already scaled; the popover is placed in
  // viewport coordinates, so it needs the page's own position added.
  const anchor = useCallback(
    (): DOMRect | null => anchorForPageRect(pageIndex, rect),
    [rect, pageIndex]
  )

  const guard = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const open = (view: AiCardState['view'], asking: boolean): Promise<void> =>
    guard(async () => {
      const cap = await onCapture()
      if (cap) onOpenCard({ cap, rect, pageIndex, view, asking })
    })

  if (cardOpen) return null

  return (
    <FloatingPopover anchor={anchor}>
      <SelectionToolbar
        busy={busy}
        activeMode={null}
        asking={false}
        onSwatch={(color) => void guard(async () => void (await onCreate(color, false)))}
        onNote={() => void guard(async () => void (await onCreate(DEFAULT_HIGHLIGHT_COLOR, true)))}
        onCopy={async () => (await onCopy?.()) ?? false}
        onMode={(mode) => void open({ mode }, false)}
        onAsk={() => void open(null, true)}
        onAttach={
          onStudyAttach
            ? () =>
                void guard(async () => {
                  const cap = await onCapture()
                  if (cap) onStudyAttach(textAttachment(cap.selectionText, cap.page, cap.surroundingContext))
                })
            : undefined
        }
      />
    </FloatingPopover>
  )
}

/**
 * The toolbar grown into an answer card. It is anchored to the page and rect
 * captured when it opened (like the floating HUD it replaced), so it keeps
 * its place and its stream when the selection plugin remounts or drops the
 * in-page menu. Esc, a press outside, or Continue closes it.
 */
function AiCard({
  card,
  onChange,
  onClose,
  onCreate,
  onSaveAiNote,
  onStudyAttach,
  onStudyContinue,
  docTitle,
  sourceUrl,
  author
}: {
  card: AiCardState
  onChange: (card: AiCardState) => void
  onClose: () => void
  onCreate: (color: string, withNote: boolean) => Promise<void>
  onSaveAiNote: (note: string) => Promise<void>
  onStudyAttach?: (attachment: StudyAttachment) => void
  onStudyContinue?: (messages: StudyMessage[]) => void
  docTitle: string
  sourceUrl?: string
  author?: string
}): React.JSX.Element {
  const { cap, view, asking } = card
  const [busy, setBusy] = useState(false)
  const [question, setQuestion] = useState('')
  const anchor = useCallback(
    (): DOMRect | null => anchorForPageRect(card.pageIndex, card.rect),
    [card.pageIndex, card.rect]
  )
  const attachment = textAttachment(cap.selectionText, cap.page, cap.surroundingContext)

  const guard = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <FloatingPopover anchor={anchor} className="kh-ai-mode" onDismiss={onClose}>
      <SelectionToolbar
        busy={busy}
        activeMode={view?.mode ?? null}
        asking={asking}
        onSwatch={(color) => void guard(() => onCreate(color, false))}
        onNote={() => void guard(() => onCreate(DEFAULT_HIGHLIGHT_COLOR, true))}
        onCopy={async () => {
          try {
            await navigator.clipboard.writeText(cap.selectionText)
            return true
          } catch {
            return false
          }
        }}
        onMode={(mode) => onChange({ ...card, view: { mode }, asking: false })}
        onAsk={() => onChange({ ...card, asking: !asking })}
        onAttach={
          onStudyAttach
            ? () => {
                onStudyAttach(attachment)
                onClose()
              }
            : undefined
        }
      />

      {asking && (
        <form
          className="kh-ai-input"
          onSubmit={(e) => {
            e.preventDefault()
            const q = question.trim()
            if (!q) return
            onChange({ ...card, view: { mode: 'custom', prompt: q }, asking: false })
          }}
        >
          <input
            className="kh-input"
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about this selection…"
            aria-label="Ask about this selection"
          />
          <button type="submit" className="kh-btn kh-primary" disabled={!question.trim()}>
            <span>Ask</span>
          </button>
        </form>
      )}

      {view && (
        <InlineAnswer
          key={`${view.mode}:${view.prompt ?? ''}`}
          mode={view.mode}
          prompt={view.prompt}
          selectionText={cap.selectionText}
          surroundingContext={cap.surroundingContext}
          pageText={cap.pageText}
          docTitle={docTitle}
          docKind="pdf"
          sourceUrl={sourceUrl}
          author={author}
          onSaveAsNote={onSaveAiNote}
          onContinue={
            onStudyContinue
              ? (text) => {
                  onStudyContinue(
                    buildContinueMessages({ mode: view.mode, prompt: view.prompt, answer: text, attachment })
                  )
                  onClose()
                }
              : undefined
          }
        />
      )}
    </FloatingPopover>
  )
}

/**
 * Editor for an existing highlight.
 *
 * Same three states as the Web pane, for the same reasons: a highlight with a
 * note shows the note (reading one shouldn't cost a trip through an editor),
 * one without shows the actions, and editing is one explicit click away.
 */
function HighlightPopover({
  highlight,
  anchor,
  editingNote,
  onEditNote,
  onSaveNote,
  onRecolor,
  onDelete,
  onDismiss
}: {
  highlight: Highlight
  anchor: () => DOMRect | null
  editingNote: boolean
  onEditNote: () => void
  onSaveNote: (note: string) => Promise<void>
  onRecolor: (color: string) => Promise<void>
  onDelete: () => Promise<void>
  onDismiss: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(highlight.note || '')
  const [busy, setBusy] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const accent = hexForColor(highlight.color)

  useEffect(() => {
    setDraft(highlight.note || '')
  }, [highlight.id, highlight.note])

  useEffect(() => {
    if (!editingNote) return
    // After layout, so the popover doesn't jump under the caret.
    const frame = requestAnimationFrame(() => {
      const ta = textarea.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
    })
    return () => cancelAnimationFrame(frame)
  }, [editingNote])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await onSaveNote(draft.trim())
    } finally {
      setBusy(false)
    }
  }

  const copy = (): void => {
    void navigator.clipboard?.writeText(highlight.text || '').catch(() => undefined)
    onDismiss()
  }

  if (editingNote) {
    return (
      <FloatingPopover anchor={anchor} className="kh-note-mode" onDismiss={onDismiss}>
        <div className="kh-quote" style={{ '--kh-accent': accent } as React.CSSProperties}>
          {highlight.text}
        </div>
        <textarea
          ref={textarea}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void save()
            }
          }}
          placeholder="Add a note…"
          className="kh-ta"
        />
        <div className="kh-row">
          <span className="kh-hint">⌘↩ to save</span>
          <div className="kh-spacer" />
          {/* Cancel returns to the reading view rather than dismissing: it
              confirms what is stored, and it is where Save lands too. */}
          <PopButton label="Cancel" onClick={onDismiss} />
          <PopButton label="Save" primary disabled={busy} onClick={() => void save()} />
        </div>
      </FloatingPopover>
    )
  }

  if (highlight.note) {
    return (
      <FloatingPopover anchor={anchor} className="kh-read-mode" onDismiss={onDismiss}>
        <div
          className="kh-note-view"
          tabIndex={0}
          style={{ '--kh-accent': accent } as React.CSSProperties}
        >
          {highlight.note}
        </div>
        <div className="kh-toolbar">
          <SwatchRow
            active={highlight.color ?? null}
            disabled={busy}
            onPick={(color) => void onRecolor(color)}
          />
          <div className="kh-spacer" />
          <PopButton label="Edit" icon={ICON_NOTE} onClick={onEditNote} />
          <PopButton label="Copy highlighted text" icon={ICON_COPY} iconOnly onClick={copy} />
          <PopButton
            label="Delete highlight"
            icon={ICON_TRASH}
            iconOnly
            danger
            disabled={busy}
            onClick={() => void onDelete()}
          />
        </div>
      </FloatingPopover>
    )
  }

  return (
    <FloatingPopover anchor={anchor} onDismiss={onDismiss}>
      <SwatchRow
        active={highlight.color ?? null}
        disabled={busy}
        onPick={(color) => void onRecolor(color)}
      />
      <div className="kh-sep" />
      <PopButton label="Note" icon={ICON_NOTE} onClick={onEditNote} />
      <PopButton label="Copy" icon={ICON_COPY} onClick={copy} />
      <PopButton
        label="Delete"
        icon={ICON_TRASH}
        danger
        disabled={busy}
        onClick={() => void onDelete()}
      />
    </FloatingPopover>
  )
}
