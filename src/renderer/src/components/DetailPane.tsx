import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { hexForColor as colorFor } from '../../../shared/highlightUi'
import type { Bookmark, Highlight, UpdateBookmarkInput, WebPaneState } from '../../../shared/types'
import { useBookmark, useDeleteBookmark, useHighlightsForBookmark, useUpdateBookmark } from '../lib/queries'
import type { FindStep } from '../lib/findStep'
import { FOCUS_LIBRARY_SEARCH } from '../lib/libraryFocus'
import { truncateForContext, useBookmarkText } from '../lib/useBookmarkText'
import { useStudyThread, type StudySendContext } from '../lib/useStudyThread'
import { assembleDocument, type DocPage } from '../lib/studyContext'
import type { AiRef } from '../lib/aiRefs'
import { afterPaint, locatePdfRef, waitUntil, type NormalizedPage, type RefQuality, type RevealResult } from '../lib/revealRef'
import { displayForBookmark } from '../lib/bookmarkDisplay'
import { usePref } from '../lib/prefs'
import { errMessage } from '../lib/errors'
import AssetImage from './AssetImage'
import ConfirmDialog from './ConfirmDialog'
import EditableField from './EditableField'
import Icon from './Icon'
import ListMembership from './ListMembership'
import PdfPane, { type PdfDocumentReader } from './PdfPane'
import TagEditor from './TagEditor'
import WebPane from './WebPane'
import StudyPanel from './StudyPanel'
import SidePanel from './SidePanel'
import { STUDY_BUDGET_CHARS, isStudyAsset, type StudyAttachment, type StudyMessage } from '../../../shared/study'
import { TRAFFIC_LIGHT_INSET } from './TitlebarRow'

type Tab = 'preview' | 'pdf' | 'web'

const EMPTY_WEB_STATE: WebPaneState = {
  url: '',
  title: '',
  isLoading: true,
  canGoBack: false,
  canGoForward: false,
  error: null
}

/** How long a reference click waits for the reader or page before giving up. */
const REF_READY_MS = 8000

export default function DetailPane({
  bookmark: selected,
  onDeleted,
  focusHighlightId: externalFocusHighlightId,
  onFocusHighlightHandled,
  listCollapsed,
  onExpandList,
  inFocusMode,
  onToggleFocusMode
}: {
  bookmark: Bookmark | null
  onDeleted: (id: string) => void
  /** Set when a highlight was opened from the sidebar's Highlights view. */
  focusHighlightId?: string | null
  onFocusHighlightHandled?: () => void
  listCollapsed: boolean
  onExpandList: () => void
  /** Both side panes are collapsed, so the reader fills the window. */
  inFocusMode: boolean
  onToggleFocusMode: () => void
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
  const [railOpen, setRailOpenPref] = usePref('highlightRailOpen', false)
  const [studyOpen, setStudyOpen] = useState(false)

  // One side pane at a time. Both dock to the same right-hand edge, and
  // opening the second used to stack them, leaving the page itself a
  // narrow column between two rails. Whichever you ask for wins; the
  // other stands down.
  const openRail = useCallback(
    (next: boolean) => {
      setRailOpenPref(next)
      if (next) setStudyOpen(false)
    },
    [setRailOpenPref]
  )

  // The open PDF's text, handed up by PdfPane once it is mounted. Study reads
  // the whole document through it rather than one page at a time.
  const [pdfReader, setPdfReader] = useState<PdfDocumentReader | null>(null)

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
    return bookmark.content.assetId || bookmark.assets.find((a) => a.assetType === 'bookmarkAsset' && !isStudyAsset(a))?.id || null
  }, [bookmark])
  const pdfFileName = bookmark?.content?.fileName || 'document.pdf'

  // Needed by the tab-defaulting effect below, which runs before the
  // early return that used to be the only place `display` was computed.
  const display = useMemo(() => (bookmark ? displayForBookmark(bookmark) : null), [bookmark])
  const url = display?.url

  // Grounds the sidebar chat (PageAiDrawer, below) in the bookmark's real
  // content rather than a two-line meta description — see
  // lib/useBookmarkText.ts. Called unconditionally (before the `!bookmark`
  // early return) because it's a hook; `enabled: !!bookmark` inside it makes
  // that safe to call with a possibly-null bookmark.
  const bookmarkText = useBookmarkText(bookmark, tab === 'web', STUDY_BUDGET_CHARS)

  // ── Study ────────────────────────────────────────────────────────────────
  // The chat hook lives here, not in the panel, so a question keeps streaming
  // and saves to its own bookmark when the panel is closed or the user moves
  // on, and so readers can attach to it while the panel is still closed.
  const study = useStudyThread(bookmark?.id ?? null, {
    active: studyOpen,
    docTitle: display?.title ?? bookmark?.title ?? 'Untitled'
  })

  // A PDF's text only exists inside the PDF pane, which is mounted for the
  // PDF tab's bookmark whichever tab is showing.
  const [studyPages, setStudyPages] = useState<{ bookmarkId: string; assetId: string; pages: DocPage[] } | null>(null)
  const [studyProgress, setStudyProgress] = useState<{ done: number; total: number } | null>(null)
  useEffect(() => {
    if (!studyOpen || !bookmark || !pdfAssetId || !pdfReader) return
    const id = bookmark.id
    let cancelled = false
    setStudyProgress(null)
    pdfReader
      .getDocumentPages((done, total) => {
        if (!cancelled) setStudyProgress({ done, total })
      })
      .then((pages) => {
        if (!cancelled) setStudyPages({ bookmarkId: id, assetId: pdfAssetId, pages })
      })
      // An unreadable PDF still opens Study, answering from the title.
      .catch(() => {
        if (!cancelled) setStudyPages({ bookmarkId: id, assetId: pdfAssetId, pages: [] })
      })
    return () => {
      cancelled = true
    }
  }, [studyOpen, bookmark?.id, pdfAssetId, pdfReader]) // eslint-disable-line react-hooks/exhaustive-deps

  const studyIsPdf = !!pdfAssetId
  const studyPageList = studyPages && studyPages.bookmarkId === bookmark?.id && studyPages.assetId === pdfAssetId ? studyPages.pages : null
  const studyText = studyIsPdf ? null : (bookmarkText.data?.text ?? '')
  const studyDocReady = studyIsPdf ? studyPageList !== null : !bookmarkText.isPending
  const studyHasText = studyIsPdf
    ? !!studyPageList?.some((p) => p.text)
    : !!studyText && bookmarkText.data?.source !== 'description'

  let studyScope: string
  if (!studyDocReady) {
    studyScope =
      studyIsPdf && studyProgress
        ? `Reading document… ${studyProgress.done} / ${studyProgress.total} pages`
        : 'Reading document…'
  } else if (!studyHasText) {
    studyScope = 'No page text available — answering from title and description'
  } else if (studyIsPdf) {
    const n = studyPageList?.length ?? 0
    studyScope = `Whole paper · ${n} ${n === 1 ? 'page' : 'pages'}`
  } else {
    studyScope = display?.kind === 'text' ? 'Whole note' : 'Whole article'
  }

  // Pages the question is about (attached selections and regions) are kept
  // when a very long document has to be trimmed.
  function studyContext(focusPages: number[]): StudySendContext {
    const currentPage = studyIsPdf ? pdfReader?.getCurrentPage() : undefined
    const build = (budget: number): string =>
      studyIsPdf
        ? assembleDocument(studyPageList ?? [], { budget, focusPages, currentPage })
        : truncateForContext(studyText ?? '', budget)
    const c = bookmark?.content
    return {
      documentText: build(STUDY_BUDGET_CHARS),
      rebuild: build,
      paged: studyIsPdf && studyHasText,
      currentPage,
      docTitle: display?.title ?? bookmark?.title ?? 'Untitled',
      sourceUrl: c?.url || c?.sourceUrl || undefined,
      siteName: c?.publisher || undefined,
      author: c?.author || undefined,
      docKind: studyIsPdf ? 'pdf' : display?.kind === 'text' ? 'note' : 'article'
    }
  }
  const pagesOf = (attachments?: StudyAttachment[]): number[] =>
    (attachments ?? []).flatMap((a) => (a.page !== undefined ? [a.page] : []))

  // Opening Study from the Preview tab of a PDF moves to the PDF first: its
  // text, and later its references, live there.
  const openStudy = useCallback(
    (next: boolean) => {
      setStudyOpen(next)
      if (next) {
        setRailOpenPref(false)
        if (pdfAssetId && tab === 'preview') setTab('pdf')
      }
    },
    [setRailOpenPref, pdfAssetId, tab]
  )
  const onStudyAttach = useCallback(
    (a: StudyAttachment) => {
      openStudy(true)
      study.addAttachment(a)
    },
    [openStudy, study.addAttachment] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const onStudyContinue = useCallback(
    (messages: StudyMessage[]) => {
      openStudy(true)
      study.seed(messages)
    },
    [openStudy, study.seed] // eslint-disable-line react-hooks/exhaustive-deps
  )
  // ── Study references ───────────────────────────────────────────────────
  // PDF: the reader the pane handed up knows every page's text and can scroll
  // and flash. Web: the quote is matched inside the live page by its preload,
  // so a web reference can only be checked while the page is loaded; those are
  // resolved lazily, on click, rather than forcing the Web tab open.
  const pdfReaderRef = useRef(pdfReader)
  pdfReaderRef.current = pdfReader
  const tabRef = useRef(tab)
  tabRef.current = tab

  // Pages normalised once and shared by every reference resolved against this
  // document; dropped when the reader (so the document) changes.
  const refPageCache = useRef(new Map<number, NormalizedPage>())
  useEffect(() => {
    refPageCache.current = new Map()
  }, [pdfReader])

  const onResolveRef = useCallback(
    async (ref: AiRef): Promise<RefQuality | 'unknown'> => {
      if (!pdfAssetId) return 'unknown'
      const reader = pdfReaderRef.current
      if (!reader) return 'unknown'
      const ready = await reader.whenReady(REF_READY_MS)
      if (!ready) return 'unknown'
      const found = await locatePdfRef(ref, ready.pageCount, (p) => reader.getPageText(p), {
        cache: refPageCache.current,
        yieldToLoop: true
      })
      return found.quality
    },
    [pdfAssetId]
  )

  const onRevealRef = useCallback(
    async (ref: AiRef): Promise<RevealResult> => {
      if (pdfAssetId) {
        // Preview has no reader to point at, so go to the PDF first.
        const switched = tabRef.current !== 'pdf'
        if (switched) setTab('pdf')
        const reader = await waitUntil(() => pdfReaderRef.current, REF_READY_MS)
        const ready = reader && (await reader.whenReady(REF_READY_MS))
        if (!reader || !ready) return 'unavailable'
        // The pane was mounted but hidden; let it be laid out at its real size
        // before scrolling, or the scroll lands in a zero-height container.
        if (switched) await afterPaint()
        const found = await locatePdfRef(ref, ready.pageCount, (p) => reader.getPageText(p), {
          cache: refPageCache.current
        })
        if (found.quality === 'missing') return 'missing'
        // An approximate hit goes to the page and flashes nothing.
        reader.reveal(found.page0, found.start, found.end)
        return found.quality
      }
      if (!url) return 'missing'
      if (tabRef.current !== 'web') {
        setTab('web')
        // Let the Web tab's effects run: they navigate the native view, and
        // main then waits for that load before asking the page.
        await afterPaint()
      }
      const result = await window.kk.webpane.revealQuote(ref.quote, bookmark?.id)
      return result === 'found' ? 'exact' : result === 'not-found' ? 'missing' : 'unavailable'
    },
    [pdfAssetId, url, bookmark?.id]
  )

  // View → Study panel (⌥⌘S) arrives from the app menu, like Find, so it works
  // while the native web view has focus.
  const toggleStudyRef = useRef<() => void>(() => {})
  toggleStudyRef.current = () => {
    if (bookmark) openStudy(!studyOpen)
  }
  useEffect(() => window.kk.window.onToggleStudy(() => toggleStudyRef.current()), [])

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

  // The live page's selection toolbar sends "Add to Study" and "Continue in
  // Study" through main; only the bookmark currently shown may act on them.
  useEffect(() => {
    if (!bookmark) return
    const offAttach = window.kk.webpane.onStudyAttach((p) => {
      if (p.bookmarkId === bookmark.id) onStudyAttach(p.attachment)
    })
    const offContinue = window.kk.webpane.onStudyContinue((p) => {
      if (p.bookmarkId === bookmark.id) onStudyContinue(p.messages)
    })
    return () => {
      offAttach()
      offContinue()
    }
  }, [bookmark, onStudyAttach, onStudyContinue])

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
    // Matches belong to the document that was on screen.
    setFindOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookmark?.id])

  // ── Find in document ──────────────────────────────────────────────────
  // ⌘F, ⌘G and ⇧⌘G arrive from the app menu (see main/menu.ts) because
  // that is the only place a shortcut reaches us while the native web view
  // has focus. Whether ⌘F means "find here" or "search the library" depends
  // on whether a reader is showing, which only this component knows.
  const readerOpen = !!bookmark && ((tab === 'pdf' && !!pdfAssetId) || (tab === 'web' && !!url))
  // ── Region capture ─────────────────────────────────────────────────────
  // Drag a rectangle over a figure or equation and it becomes an image chip in
  // Study. On a PDF the crosshair is a React overlay on the pages; on the web
  // the native view covers this UI, so it lives in the page itself.
  const [capturing, setCapturing] = useState(false)
  const captureTokenRef = useRef(0)
  const [captureNote, setCaptureNote] = useState<string | null>(null)
  useEffect(() => {
    if (!captureNote) return
    const t = setTimeout(() => setCaptureNote(null), 4000)
    return () => clearTimeout(t)
  }, [captureNote])
  const cancelCapture = useCallback(() => {
    captureTokenRef.current++
    setCapturing(false)
    pdfReaderRef.current?.cancelRegionCapture()
    void window.kk.webpane.cancelCapture().catch(() => {})
  }, [])
  const startCapture = useCallback(async () => {
    if (capturing) return cancelCapture()
    const token = ++captureTokenRef.current
    setCapturing(true)
    try {
      let a: StudyAttachment | null = null
      if (tab === 'pdf') {
        a = (await pdfReaderRef.current?.startRegionCapture()) ?? null
      } else if (tab === 'web') {
        const r = await window.kk.webpane.captureRegion()
        if (r && 'error' in r) {
          if (token === captureTokenRef.current) setCaptureNote(r.error)
        } else if (r) a = { kind: 'region', label: 'Region', rect: { x: 0, y: 0, width: 0, height: 0 }, text: r.text || undefined, imageDataUrl: r.imageDataUrl }
      }
      if (a && token === captureTokenRef.current) onStudyAttach(a)
    } catch {
      // A failed capture just leaves nothing attached.
    } finally {
      if (token === captureTokenRef.current) setCapturing(false)
    }
  }, [capturing, tab, cancelCapture, onStudyAttach])
  // Leaving the tab or bookmark abandons a crosshair that is still up.
  useEffect(() => cancelCapture, [tab, bookmark?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const canCapture = tab === 'pdf' ? !!pdfAssetId && !!pdfReader : tab === 'web' && !!url

  const [findOpen, setFindOpen] = useState(false)
  const [findFocusSignal, setFindFocusSignal] = useState(0)
  const [findStep, setFindStep] = useState<FindStep | null>(null)
  const readerOpenRef = useRef(readerOpen)
  readerOpenRef.current = readerOpen

  // Leaving the reader (another tab) ends the search too.
  useEffect(() => {
    if (!readerOpen) setFindOpen(false)
  }, [readerOpen])

  useEffect(() => {
    const offFind = window.kk.window.onFind(() => {
      if (!readerOpenRef.current) {
        window.dispatchEvent(new Event(FOCUS_LIBRARY_SEARCH))
        return
      }
      setFindOpen(true)
      setFindFocusSignal((n) => n + 1)
    })
    const offNext = window.kk.window.onFindNext(() => setFindStep({ forward: true }))
    const offPrev = window.kk.window.onFindPrevious(() => setFindStep({ forward: false }))
    return () => {
      offFind()
      offNext()
      offPrev()
    }
  }, [])

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
    openRail(true)
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
      <div className="relative flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        {/* With the panes collapsed this is the leftmost surface, so it
            holds the window's drag strip and traffic-light room. */}
        {inFocusMode && <div className="titlebar-drag absolute inset-x-0 top-0 h-[52px]" />}
        <Icon name="library" size={32} className="text-neutral-300 dark:text-neutral-700" />
        <div>
          <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">Nothing selected</p>
          <p className="mt-1 text-xs text-neutral-400">
            {listCollapsed
              ? 'The bookmark list is hidden.'
              : 'Pick a bookmark on the left, or use ↑ and ↓ to move through the list.'}
          </p>
        </div>
        {/* The expand/collapse button lives in the reader's bar, which this
            state doesn't have — so in focus mode with nothing to read the
            way back must be offered here, or the user is stranded. */}
        {listCollapsed && (
          <button
            onClick={inFocusMode ? onToggleFocusMode : onExpandList}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {inFocusMode ? 'Show sidebar and list' : 'Show bookmark list'}
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
      {/* In focus mode this bar is the window's top-left edge: it reserves
          room for the macOS traffic lights and doubles as the drag region
          (buttons opt out with titlebar-no-drag). Otherwise it sits beside
          other panes and needs neither. */}
      <div
        className={`flex items-center gap-1 border-b border-neutral-200 px-3 pt-2 dark:border-neutral-800 ${
          inFocusMode ? 'titlebar-drag' : ''
        }`}
        style={inFocusMode ? { paddingLeft: TRAFFIC_LIGHT_INSET } : undefined}
      >
        {tabs.map((t) => (
          <button
            key={t}
            data-testid={`tab-${t}`}
            onClick={() => setTab(t)}
            className={`titlebar-no-drag rounded-t-md px-3 py-1.5 text-sm capitalize transition-colors ${
              tab === t
                ? 'border-b-2 border-emerald-600 font-medium text-emerald-700 dark:text-emerald-400'
                : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
            }`}
          >
            {t === 'web' ? 'Web' : t === 'pdf' ? 'PDF' : 'Preview'}
          </button>
        ))}

        <div className="titlebar-no-drag ml-auto flex items-center gap-0.5 pb-1.5">
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

          {/* Highlights and Study are the same two controls on every tab.
              They used to be conditional — the rail button appeared only
              once a bookmark already had highlights, and the AI button was
              hidden on PDFs because the PDF pane carried its own copy in a
              second toolbar. Both read as "this app can't do that here".
              They are always present now, and the PDF pane's bar keeps only
              what is genuinely PDF-specific (paging, zoom, night mode). */}
          <button
            type="button"
            data-testid="detail-highlights"
            onClick={() => openRail(!railOpen)}
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

          <button
            type="button"
            data-testid="detail-study"
            onClick={() => openStudy(!studyOpen)}
            aria-pressed={studyOpen}
            title={studyOpen ? 'Close Study panel (⌥⌘S)' : 'Open Study panel (⌥⌘S)'}
            className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition ${
              studyOpen
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800'
            }`}
          >
            <Icon name="study" size={14} />
            <span>Study</span>
          </button>
          <button
            type="button"
            data-testid="detail-capture-region"
            onClick={() => void startCapture()}
            disabled={!capturing && !canCapture}
            aria-pressed={capturing}
            title={capturing ? 'Cancel capture (Esc)' : 'Capture region: drag over a figure or equation to ask about it'}
            className={`flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition disabled:opacity-40 ${
              capturing
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800'
            }`}
          >
            <Icon name="region" size={14} />
            <span>Capture region</span>
          </button>
          {captureNote && (
            <span role="status" className="text-xs text-amber-600 dark:text-amber-400">
              {captureNote}
            </span>
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
          <span className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-800" aria-hidden />
          {/* One control for the whole layout, in the reader's own bar (the
              native web view is drawn over the content area, so it can't
              live there). It toggles Focus Mode — which already remembers
              and restores the prior panes — instead of two pane buttons the
              user had to juggle. The ⌃⌘F menu item stays as the keyboard path. */}
          <button
            type="button"
            data-testid="detail-expand"
            onClick={onToggleFocusMode}
            aria-pressed={inFocusMode}
            aria-label={inFocusMode ? 'Show sidebar and list' : 'Expand reader'}
            title={inFocusMode ? 'Show sidebar and list (⌃⌘F)' : 'Expand reader — hide sidebar and list (⌃⌘F)'}
            className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
          >
            <Icon name={inFocusMode ? 'collapse' : 'expand'} />
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
                title={display?.title || bookmark.title || pdfFileName}
                bookmarkId={bookmark.id}
                highlights={highlights}
                focusHighlightId={tab === 'pdf' ? focusHighlightId : null}
                onFocusHandled={clearFocus}
                onAnchorStatus={handleAnchorStatus}
                sourceUrl={content?.sourceUrl || content?.url || undefined}
                author={content?.author || content?.publisher || undefined}
                onDocumentReader={setPdfReader}
                onStudyAttach={onStudyAttach}
                onStudyContinue={onStudyContinue}
                findOpen={findOpen && tab === 'pdf'}
                findFocusSignal={findFocusSignal}
                findStep={findStep}
                onFindClose={() => setFindOpen(false)}
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
                onStudyAttach={onStudyAttach}
                onStudyContinue={onStudyContinue}
                findOpen={findOpen && tab === 'web'}
                findFocusSignal={findFocusSignal}
                findStep={findStep}
                onFindClose={() => setFindOpen(false)}
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

        {railOpen && (
          <HighlightRail
            highlights={highlights}
            anchored={anchored}
            activeId={focusHighlightId}
            inPdf={!!pdfAssetId}
            onOpen={openHighlight}
            onClose={() => openRail(false)}
          />
        )}

        {/* One panel for every kind of bookmark, docked to the same edge as
            the highlight rail. It reads the whole document: the PDF's pages,
            or the article's text. */}
        {studyOpen && (
          <StudyPanel
            onClose={() => setStudyOpen(false)}
            scopeLine={studyScope}
            documentReady={studyDocReady}
            paged={studyIsPdf && studyHasText}
            thread={study.thread}
            chatReady={study.ready}
            syncState={study.syncState}
            pending={study.pending}
            streaming={study.streaming}
            busy={study.busy}
            streamText={study.streamText}
            error={study.error}
            canRetry={study.canRetry}
            onSend={(q) => study.send(q, studyContext(pagesOf(study.pending)))}
            onStop={study.stop}
            onRetry={() =>
              study.retry(studyContext(pagesOf(study.thread?.messages[study.thread.messages.length - 1]?.attachments)))
            }
            onClear={study.clear}
            onRemoveAttachment={study.removeAttachment}
            onRetrySync={study.retrySync}
            onRevealRef={onRevealRef}
            onResolveRef={onResolveRef}
            refSource={pdfReader}
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
    <SidePanel
      title="Highlights"
      count={highlights.length}
      subtitle={inPdf ? 'In this PDF' : 'On this page'}
      onClose={onClose}
      closeLabel="Hide highlights"
    >
      {highlights.length === 0 ? (
        /* The rail is reachable from the toolbar now even when there is
           nothing in it, so it has to say what it's for rather than open
           as a blank column. */
        <p className="px-3 py-4 text-xs leading-relaxed text-neutral-400">
          No highlights yet. Select text {inPdf ? 'in the PDF' : 'on the page'} and pick a colour to save
          one here.
        </p>
      ) : (
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
      )}
    </SidePanel>
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
