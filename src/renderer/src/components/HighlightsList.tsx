import React, { useEffect, useMemo, useRef } from 'react'
import { useAllHighlights, useBookmark } from '../lib/queries'
import { hexForColor, HIGHLIGHT_COLORS } from '../../../shared/highlightUi'
import { displayForBookmark } from '../lib/bookmarkDisplay'
import Icon from './Icon'
import type { Bookmark, Highlight } from '../../../shared/types'

/**
 * Every highlight in the library, newest first, optionally narrowed to a
 * set of colours.
 *
 * This takes the middle pane's slot in place of BookmarkList when the
 * sidebar's Highlights view is selected. Highlights were previously
 * reachable only by first finding the bookmark they belong to and opening
 * its Preview tab — which is exactly backwards for the "what did I mark
 * up last week" question people actually ask of them.
 *
 * Two API facts shape this component:
 *
 * 1. `GET /highlights` has no colour parameter, so filtering happens here,
 *    over loaded pages. The header says "of N loaded" rather than
 *    implying a library-wide total, and the pager keeps pulling while the
 *    filter is on so a rare colour still fills the pane.
 * 2. A highlight carries `bookmarkId` but no bookmark title. Each row
 *    resolves its own source through the shared ['bookmark', id] query, so
 *    React Query dedupes the ten highlights that came from one article
 *    into a single request, and rows that never scroll into view never
 *    ask.
 */
export default function HighlightsList({
  colors,
  selectedId,
  onOpenHighlight
}: {
  colors: string[]
  selectedId: string | null
  /** Select the source bookmark and scroll its pane to this highlight. */
  onOpenHighlight: (bookmark: Bookmark, highlightId: string) => void
}): React.JSX.Element {
  const query = useAllHighlights()

  const loaded = useMemo(
    () => (query.data?.pages ?? []).flatMap((p) => p.highlights),
    [query.data]
  )
  const filtered = useMemo(() => {
    if (colors.length === 0) return loaded
    // A highlight with no stored colour is rendered as yellow everywhere
    // else in the app (hexForColor falls back to the first swatch), so it
    // has to match a yellow filter here too — otherwise filtering by the
    // default colour hides the majority of a typical library.
    return loaded.filter((h) => colors.includes(h.color ?? HIGHLIGHT_COLORS[0].name))
  }, [loaded, colors])

  // Keep pulling while a filter is active and the visible result is thin.
  // Without this, filtering to a colour used once a month shows an empty
  // pane on a library whose first page happens to be all yellow, and
  // there is nothing to scroll to trigger the next page.
  const { isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } = query
  useEffect(() => {
    if (isLoading || isFetchingNextPage || !hasNextPage) return
    if (colors.length > 0 && filtered.length < 15) void fetchNextPage()
    // Deps are the primitives rather than `query`, whose identity changes
    // on every render — this effect would otherwise re-run continuously.
  }, [colors.length, filtered.length, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage])

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    function onScroll(): void {
      if (!el) return
      if (el.scrollTop + el.clientHeight > el.scrollHeight - 300 && query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage()
      }
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [query])

  const activeSwatches = colors.length > 0 ? HIGHLIGHT_COLORS.filter((c) => colors.includes(c.name)) : []

  return (
    <div className="flex h-full flex-col border-r border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-neutral-800 dark:text-neutral-200">
            <Icon name="highlight" size={15} className="text-neutral-400" />
            Highlights
            {activeSwatches.length > 0 && (
              <span className="flex items-center gap-1" aria-label={`Filtered to ${colors.join(', ')}`}>
                {activeSwatches.map((c) => (
                  <span key={c.name} className="block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c.hex }} />
                ))}
              </span>
            )}
          </div>
          <div className="text-xs tabular-nums text-neutral-500">
            {query.isLoading
              ? 'Loading…'
              : colors.length > 0
                ? `${filtered.length} of ${loaded.length} loaded`
                : `${loaded.length} loaded${query.hasNextPage ? '+' : ''}`}
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto" data-testid="highlights-list">
        {query.isLoading && (
          <div className="space-y-3 p-3" aria-hidden>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex gap-2.5">
                <div className="w-1 animate-pulse rounded-full bg-neutral-200 dark:bg-neutral-800" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 animate-pulse rounded bg-neutral-200/70 dark:bg-neutral-800" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-neutral-200/70 dark:bg-neutral-800" />
                </div>
              </div>
            ))}
          </div>
        )}

        {query.isError && (
          <div className="p-4 text-sm text-red-600 dark:text-red-400">
            Couldn’t load highlights. {query.error.message}
          </div>
        )}

        {!query.isLoading && filtered.length === 0 && (
          <div className="px-6 py-12 text-center">
            <Icon name="highlight" size={28} className="mx-auto mb-3 text-neutral-300 dark:text-neutral-700" />
            <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
              {colors.length > 0 ? 'No highlights in these colours' : 'No highlights yet'}
            </p>
            <p className="mt-1 text-xs text-neutral-400">
              {colors.length > 0
                ? query.hasNextPage
                  ? 'Still loading older highlights — scroll to keep looking.'
                  : 'Try another colour, or clear the filter in the sidebar.'
                : 'Select text in the Web or PDF pane of a bookmark to make one.'}
            </p>
          </div>
        )}

        <ul>
          {filtered.map((h) => (
            <HighlightRow
              key={h.id}
              highlight={h}
              selected={h.id === selectedId}
              onOpen={onOpenHighlight}
            />
          ))}
        </ul>

        {query.isFetchingNextPage && (
          <div className="p-3 text-center text-xs text-neutral-400">Loading more…</div>
        )}
      </div>
    </div>
  )
}

function HighlightRow({
  highlight,
  selected,
  onOpen
}: {
  highlight: Highlight
  selected: boolean
  onOpen: (bookmark: Bookmark, highlightId: string) => void
}): React.JSX.Element {
  // Shared cache key with the detail pane, so opening a highlight whose
  // source is already on screen costs no request at all.
  const source = useBookmark(highlight.bookmarkId)
  const bookmark = source.data
  const display = bookmark ? displayForBookmark(bookmark) : null

  return (
    <li>
      <button
        type="button"
        data-testid="highlight-row"
        // Disabled until the source resolves: the detail pane is driven by
        // a Bookmark object, and there is nothing useful to do with a
        // click that can't produce one yet.
        disabled={!bookmark}
        onClick={() => bookmark && onOpen(bookmark, highlight.id)}
        title={bookmark ? `Open in "${display?.title}"` : 'Loading source…'}
        className={`flex w-full gap-2.5 border-b border-neutral-100 px-3 py-3 text-left transition-colors disabled:cursor-default dark:border-neutral-900 ${
          selected ? 'bg-emerald-600/10' : 'hover:bg-neutral-50 dark:hover:bg-neutral-900/60'
        }`}
      >
        <span
          aria-hidden
          className="w-1 shrink-0 self-stretch rounded-full"
          style={{ backgroundColor: hexForColor(highlight.color) }}
        />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-3 text-sm leading-snug text-neutral-800 dark:text-neutral-200">
            {highlight.text || <em className="text-neutral-400">(no text captured)</em>}
          </span>
          {highlight.note && (
            <span className="mt-1 line-clamp-2 text-xs leading-snug text-neutral-500 dark:text-neutral-400">
              {highlight.note}
            </span>
          )}
          <span className="mt-1.5 flex items-center gap-1 text-[11px] text-neutral-400">
            {source.isLoading ? (
              <span className="inline-block h-2.5 w-32 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
            ) : (
              <>
                <Icon name="chevron-right" size={11} />
                <span className="truncate">{display?.title ?? 'Unknown source'}</span>
              </>
            )}
          </span>
        </span>
      </button>
    </li>
  )
}
