import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { Bookmark } from '../../../shared/types'

/**
 * Resolves the best available body of text to ground a sidebar chat in.
 *
 * DetailPane used to hand PageAiDrawer `bookmark.content?.text ||
 * bookmark.content?.description || bookmark.title` — for a `link` bookmark
 * (the main use case: someone saved a URL), `content.text` is unset and
 * `description` is a two-line meta description, so "chat with the content
 * of the bookmark" had no content to chat with. This resolves, in priority
 * order:
 *
 *   1. the live web pane's rendered text, when the Web tab is actually
 *      showing this bookmark (freshest and most complete — real DOM text,
 *      not whatever Karakeep's crawler captured at save time);
 *   2. `content.htmlContent` stripped to plain text (the reader-view HTML
 *      Karakeep sometimes stores inline);
 *   3. the reader-view asset at `content.contentAssetId`, fetched as raw
 *      bytes and stripped the same way (Karakeep's separately-stored full
 *      reader extraction);
 *   4. `content.text` (the `text`-type bookmark's own body);
 *   5. `content.description` (last resort — better than nothing).
 *
 * Async and TanStack-Query-cached, following this file's queries.ts sibling:
 * step 1 is an IPC round trip into the live WebContentsView and step 3 is a
 * full asset fetch, neither of which should re-run on every keystroke in
 * the chat input.
 */

// Gemini's context window comfortably fits far more than this, but a
// 24k-character ceiling keeps each request's latency and cost predictable
// regardless of how long the underlying article is — the kind of runaway
// prompt size a single very long page could otherwise produce unbounded.
const MAX_CHARS = 24_000
const TRIM_MARKER = '\n\n[… trimmed …]\n\n'

/**
 * Head + tail truncation rather than a bare `.slice(0, MAX_CHARS)`: a long
 * article's conclusion, sources, or final numbers are often exactly what a
 * question is about, and a naive prefix-only cut would silently discard all
 * of that while keeping only the introduction.
 */
export function truncateForContext(text: string, maxChars = MAX_CHARS): string {
  if (text.length <= maxChars) return text
  const budget = maxChars - TRIM_MARKER.length
  const headLen = Math.ceil(budget * 0.65)
  const tailLen = budget - headLen
  return text.slice(0, headLen) + TRIM_MARKER + text.slice(text.length - tailLen)
}

/**
 * Strips tags/script/style from an HTML string down to reading text. Uses
 * DOMParser rather than a regex strip — regexing HTML reliably is a losing
 * game (nested/malformed tags, CDATA, attributes containing `>`), and
 * DOMParser's output is never inserted back into this app's own DOM (it's
 * read via `.textContent`, then handed to Gemini as a plain string), so
 * there's no injection surface opened by using it here.
 */
function stripHtml(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    doc.querySelectorAll('script, style, noscript, template').forEach((el) => el.remove())
    return (doc.body?.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  } catch {
    return ''
  }
}

async function fetchAssetText(assetId: string): Promise<string> {
  try {
    const bytes = await window.kk.assets.getBytes(assetId)
    const html = new TextDecoder('utf-8').decode(bytes)
    return stripHtml(html)
  } catch {
    return ''
  }
}

export interface BookmarkTextResult {
  text: string
  /** Which source actually supplied the text, for callers that want to say so. */
  source: 'live-page' | 'html-content' | 'reader-asset' | 'text' | 'description' | 'none'
}

export function useBookmarkText(
  bookmark: Bookmark | null | undefined,
  webTabActive: boolean
): UseQueryResult<BookmarkTextResult, Error> {
  const content = bookmark?.content

  return useQuery({
    // webTabActive is part of the key: switching from Web to Preview (or
    // back) should re-resolve which source wins, not keep serving whatever
    // was cached for the other tab.
    queryKey: ['bookmarkText', bookmark?.id, webTabActive, content?.htmlContent, content?.contentAssetId, content?.text, content?.description],
    queryFn: async (): Promise<BookmarkTextResult> => {
      if (webTabActive) {
        const live = await window.kk.webpane.getPageText()
        // A handful of characters is nav chrome or a loading spinner, not a
        // page worth grounding a chat in — fall through to the stored
        // content rather than "chatting" with an empty page.
        if (live && live.trim().length > 200) {
          return { text: truncateForContext(live.trim()), source: 'live-page' }
        }
      }

      if (content?.htmlContent) {
        const stripped = stripHtml(content.htmlContent)
        if (stripped) return { text: truncateForContext(stripped), source: 'html-content' }
      }

      if (content?.contentAssetId) {
        const assetText = await fetchAssetText(content.contentAssetId)
        if (assetText) return { text: truncateForContext(assetText), source: 'reader-asset' }
      }

      if (content?.text) {
        return { text: truncateForContext(content.text), source: 'text' }
      }

      if (content?.description) {
        return { text: content.description, source: 'description' }
      }

      return { text: '', source: 'none' }
    },
    enabled: !!bookmark,
    // The live page can genuinely change (scrolled/hydrated/paginated)
    // without any bookmark field changing, so this is intentionally not
    // treated as forever-fresh the way most of this app's queries are.
    staleTime: 15_000
  })
}
