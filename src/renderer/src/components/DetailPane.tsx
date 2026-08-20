import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { hexForColor as colorFor } from '../../../shared/highlightUi'
import type { Bookmark } from '../../../shared/types'
import { useHighlightsForBookmark } from '../lib/queries'
import { displayForBookmark } from '../lib/bookmarkDisplay'
import AssetImage from './AssetImage'
import PdfPane from './PdfPane'
import WebPane from './WebPane'

type Tab = 'preview' | 'pdf' | 'web'

export default function DetailPane({ bookmark }: { bookmark: Bookmark | null }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('preview')
  const highlights = useHighlightsForBookmark(bookmark?.id)
  const queryClient = useQueryClient()
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

  // The PDF pane reports which highlights it could place, the same way the
  // Web pane's preload does — one list, whichever pane is showing.
  const handleAnchorStatus = useCallback((anchoredIds: string[]) => {
    setAnchored(new Set(anchoredIds))
  }, [])

  // The Web pane's preload posts highlight create/update/delete events to
  // main, which syncs them to the server and then pushes this event back.
  // Without this, a note edited or deleted in the live pane would keep
  // showing its old text in the Preview tab's highlight list until the
  // bookmark was reselected or the app reloaded.
  useEffect(() => {
    return window.kk.webpane.onHighlightsChanged(({ bookmarkId }) => {
      if (bookmark && bookmarkId === bookmark.id) {
        void queryClient.invalidateQueries({ queryKey: ['highlights', 'bookmark', bookmark.id] })
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
    // A stored PDF *is* the bookmark, so open on it rather than on a preview
    // card that only restates the file name.
    setTab(pdfAssetId ? 'pdf' : 'preview')
    setAnchored(null)
    setFocusHighlightId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookmark?.id])

  useEffect(() => {
    if (bookmark && window.kk.dev.isSmoke) {
      window.kk.dev.notifyDetailReady()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookmark?.id])

  useEffect(() => {
    if (!window.kk.dev.isSmoke) return
    window.kk.dev.onSwitchToWeb(() => setTab('web'))
  }, [])

  useEffect(() => {
    if (tab === 'web' && window.kk.dev.isSmoke) {
      const t = setTimeout(() => window.kk.dev.notifyWebReady(), 1500)
      return () => clearTimeout(t)
    }
    return undefined
  }, [tab])

  if (!bookmark) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-400">
        Select a bookmark
      </div>
    )
  }

  const content = bookmark.content
  const display = displayForBookmark(bookmark)
  const title = display.title
  const url = display.url
  const tabs: Tab[] = ['preview', ...(pdfAssetId ? (['pdf'] as Tab[]) : []), 'web']

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-neutral-200 px-3 pt-2 dark:border-neutral-800">
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
      </div>

      <div className="min-h-0 flex-1">
        <div className={tab === 'preview' ? 'h-full overflow-y-auto' : 'hidden'}>
          <div className="p-5">
            {content?.imageAssetId && (
              <AssetImage
                assetId={content.imageAssetId}
                className="mb-4 max-h-64 w-full rounded-lg object-cover"
              />
            )}
            <h2 className="mb-1 text-lg font-semibold leading-snug">{title}</h2>
            {url && (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  window.kk.webpane.openExternal(url)
                }}
                className="mb-3 block truncate text-xs text-emerald-600 hover:underline dark:text-emerald-400"
              >
                {url}
              </a>
            )}
            {bookmark.tags && bookmark.tags.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-1.5">
                {bookmark.tags.map((t) => (
                  <span
                    key={t.id}
                    className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  >
                    #{t.name}
                  </span>
                ))}
              </div>
            )}
            {content?.description && (
              <p className="mb-4 text-sm text-neutral-600 dark:text-neutral-300">{content.description}</p>
            )}
            {display.kind === 'text' && content?.text && (
              <blockquote className="mb-4 rounded-lg border-l-4 border-neutral-300 bg-neutral-50 p-3 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
                {content.text}
              </blockquote>
            )}
            {display.kind === 'asset' && (
              <div className="mb-4 flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
                <span className="text-2xl">{content?.assetType === 'pdf' ? '📄' : '📎'}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-neutral-800 dark:text-neutral-200">
                    {display.subtitle || 'Attached file'}
                  </div>
                  {content?.size && (
                    <div className="text-xs text-neutral-500">{(content.size / 1024 / 1024).toFixed(1)} MB</div>
                  )}
                </div>
              </div>
            )}
            {bookmark.summary && (
              <div className="mb-4 rounded-lg bg-neutral-50 p-3 text-sm text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
                <div className="mb-1 text-xs font-semibold uppercase text-neutral-400">Summary</div>
                {bookmark.summary}
              </div>
            )}
            {bookmark.note && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                <div className="mb-1 text-xs font-semibold uppercase text-amber-500">Note</div>
                {bookmark.note}
              </div>
            )}
            {highlights.length > 0 && (
              <div>
                <div className="mb-2 flex items-baseline gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                  <span>Highlights</span>
                  <span className="font-normal tabular-nums text-neutral-500">{highlights.length}</span>
                </div>
                <ul className="space-y-1.5">
                  {highlights.map((h) => {
                    const missing = anchored !== null && !anchored.has(h.id)
                    return (
                      <li key={h.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setFocusHighlightId(h.id)
                            setTab(pdfAssetId ? 'pdf' : 'web')
                          }}
                          title={pdfAssetId ? 'Show in the PDF' : 'Show on the live page'}
                          className="group flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800/70"
                        >
                          <span
                            aria-hidden
                            className="mt-0.5 w-1 shrink-0 self-stretch rounded-full"
                            style={{ backgroundColor: colorFor(h.color) }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm leading-snug text-neutral-700 dark:text-neutral-200">
                              {h.text}
                            </span>
                            {h.note && (
                              <span className="mt-1 block text-xs leading-snug text-neutral-500 dark:text-neutral-400">
                                {h.note}
                              </span>
                            )}
                            {missing && (
                              <span className="mt-1 block text-[11px] text-neutral-400">
                                {pdfAssetId ? 'Not found in this PDF' : 'Not found on the current page'}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
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
              onFocusHandled={() => setFocusHighlightId(null)}
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
              focusHighlightId={focusHighlightId}
              onFocusHandled={() => setFocusHighlightId(null)}
            />
          ) : (
            <div className="p-5 text-sm text-neutral-400">
              {display.kind === 'asset'
                ? 'This bookmark is a stored file with no source URL to load live.'
                : display.kind === 'text'
                  ? 'This note has no source URL to load live.'
                  : 'This bookmark has no URL to load.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Keep in step with COLORS in src/preload/webpane.ts.
