import DOMPurify from 'dompurify'

import { HIGHLIGHT_COLORS } from '../../../shared/highlightUi'
import type { Bookmark } from '../../../shared/types'

/**
 * The cached reader view: Karakeep's Readability pass over the crawled page,
 * stored as an HTML asset and served from `/api/assets/<id>`.
 *
 * Two decisions are baked into this file and worth stating plainly, because
 * the content is third-party HTML from whatever site the user bookmarked:
 *
 * 1. **It is sanitised** — DOMPurify, with scripts, frames, embeds, forms,
 *    `<style>` and `style=` all removed. Inline styles go because the reader
 *    is meant to look like this app's typography rather than like the
 *    leftovers of the origin site's, and dropping them takes CSS-based
 *    tricks (fixed-position overlays, `url()` beacons) with them.
 * 2. **It renders in an isolated frame, not in this renderer** — see
 *    `components/ReaderPane.tsx`. The frame is `sandbox="allow-same-origin"`
 *    with no `allow-scripts`, so nothing inside it can execute at all, while
 *    the renderer can still reach into its DOM to place highlights. That
 *    combination is the point: sanitising is the barrier that is supposed to
 *    hold, and the sandbox is the one that holds if it doesn't. Karakeep's
 *    own server serves this asset under `Content-Security-Policy: sandbox`,
 *    which is the same judgement.
 */

/** Asset type Karakeep files the reader HTML under, alongside `contentAssetId`. */
const READER_ASSET_TYPE = 'linkHtmlContent'

/**
 * Reader statuses seen or plausible from the API. `readerViewStatus` comes
 * back as `"readable"` on a bookmark that has one; the rest are here so a
 * still-crawling bookmark says "still working on it" rather than "there
 * isn't one". Anything unrecognised falls through to `unavailable`, which is
 * the honest answer when there is also no asset to show.
 */
const PENDING_STATUSES = new Set(['pending', 'crawling', 'processing', 'queued'])

export type ReaderState =
  /** There is a reader asset to fetch. */
  | { kind: 'ready'; assetId: string }
  /** The crawl or the reader pass hasn't finished yet. */
  | { kind: 'pending' }
  /** No reader view exists, and none is coming. */
  | { kind: 'unavailable'; reason: 'not-a-link' | 'failed' }

/**
 * The reader asset id. `content.contentAssetId` is the documented home for
 * it; the assets array is the fallback for bookmarks crawled by an older
 * Karakeep that only recorded it there.
 */
export function readerAssetIdFor(bookmark: Bookmark): string | null {
  if (bookmark.content?.type !== 'link') return null
  return (
    bookmark.content.contentAssetId ||
    bookmark.assets.find((a) => a.assetType === READER_ASSET_TYPE)?.id ||
    null
  )
}

export function readerStateFor(bookmark: Bookmark): ReaderState {
  if (bookmark.content?.type !== 'link') return { kind: 'unavailable', reason: 'not-a-link' }

  const assetId = readerAssetIdFor(bookmark)
  if (assetId) return { kind: 'ready', assetId }

  const status = (bookmark.content.readerViewStatus || '').toLowerCase()
  const crawl = (bookmark.content.crawlStatus || '').toLowerCase()
  if (PENDING_STATUSES.has(status) || PENDING_STATUSES.has(crawl)) return { kind: 'pending' }
  // A link that has never been crawled has no status at all; from the
  // reader's point of view that is the same as a failed one — there is
  // nothing cached to read, and the Web tab is the way to see the page.
  return { kind: 'unavailable', reason: 'failed' }
}

/** Schemes a link in the reader is allowed to point at. */
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])
/** Schemes an image in the reader is allowed to load from. */
const SAFE_IMAGE_SCHEMES = new Set(['http:', 'https:', 'data:'])

function resolveUrl(value: string, baseUrl?: string | null): string | null {
  try {
    return new URL(value, baseUrl || undefined).href
  } catch {
    return null
  }
}

function schemeOf(href: string): string | null {
  try {
    return new URL(href).protocol
  } catch {
    return null
  }
}

/**
 * Sanitise the stored reader HTML and resolve its URLs against the
 * bookmark's own URL, so a page that kept relative `src`/`href` values (most
 * don't — Readability usually absolutises them — but some do) still shows
 * its images and links somewhere real rather than resolving against
 * `about:srcdoc`.
 */
export function sanitizeReaderHtml(html: string, baseUrl?: string | null): string {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    // DOMPurify drops <script> and event handlers on its own; the rest of
    // this list is about what has no business in a reading pane even when
    // it's harmless — chrome the article shipped with, and anything that
    // would fetch or lay out something we didn't ask for.
    FORBID_TAGS: [
      'script',
      'noscript',
      'style',
      'link',
      'base',
      'meta',
      'title',
      'iframe',
      'frame',
      'frameset',
      'object',
      'embed',
      'applet',
      'form',
      'input',
      'button',
      'select',
      'option',
      'textarea',
      'audio',
      'video',
      'source',
      'track',
      'canvas',
      'dialog'
    ],
    FORBID_ATTR: ['style', 'srcset', 'sizes', 'ping', 'loading', 'target'],
    // Also drops any data-* the article carried, which matters because the
    // highlight marks are addressed by data-kk-id: nothing from the page
    // gets to claim one.
    ALLOW_DATA_ATTR: false
  })

  const host = document.createElement('div')
  host.appendChild(fragment)

  for (const a of Array.from(host.querySelectorAll('a[href]'))) {
    const resolved = resolveUrl(a.getAttribute('href') || '', baseUrl)
    const scheme = resolved ? schemeOf(resolved) : null
    if (!resolved || !scheme || !SAFE_LINK_SCHEMES.has(scheme)) {
      a.removeAttribute('href')
      continue
    }
    a.setAttribute('href', resolved)
    a.setAttribute('rel', 'noreferrer noopener nofollow')
  }

  for (const img of Array.from(host.querySelectorAll('img[src]'))) {
    const raw = img.getAttribute('src') || ''
    const resolved = raw.startsWith('data:') ? raw : resolveUrl(raw, baseUrl)
    const scheme = resolved ? schemeOf(resolved) : null
    if (!resolved || !scheme || !SAFE_IMAGE_SCHEMES.has(scheme)) {
      img.remove()
      continue
    }
    img.setAttribute('src', resolved)
    // Lazy images inside an auto-sized frame never come into view on their
    // own terms — the frame is as tall as its content, so "in view" is the
    // outer scroller's business, not the frame's.
    img.setAttribute('decoding', 'async')
  }

  // Images with no src at all (a lazy-loading page whose real URL lived in a
  // data attribute we just dropped) would render as broken-image glyphs.
  for (const img of Array.from(host.querySelectorAll('img:not([src])'))) img.remove()

  return host.innerHTML
}

/** Class the reader's highlight marks carry. Kept out of the page's way. */
export const READER_HIGHLIGHT_CLASS = 'kk-reader-hl'

function highlightRules(): string {
  const perColor = HIGHLIGHT_COLORS.map(
    ({ name, hex }) => `
.${READER_HIGHLIGHT_CLASS}[data-kk-color="${name}"] {
  --kk-solid: ${hex};
  background-color: color-mix(in srgb, ${hex} 32%, transparent);
  box-shadow: inset 0 -1.5px 0 color-mix(in srgb, ${hex} 65%, transparent);
}`
  ).join('\n')

  return `
.${READER_HIGHLIGHT_CLASS} {
  --kk-solid: ${HIGHLIGHT_COLORS[0].hex};
  background-color: color-mix(in srgb, ${HIGHLIGHT_COLORS[0].hex} 32%, transparent);
  box-shadow: inset 0 -1.5px 0 color-mix(in srgb, ${HIGHLIGHT_COLORS[0].hex} 65%, transparent);
  color: inherit;
  border-radius: 2px;
  padding: 0;
  scroll-margin-top: 24px;
}
${perColor}
.${READER_HIGHLIGHT_CLASS}[data-kk-note='1']::after {
  content: '';
  display: inline-block;
  width: 5px;
  height: 5px;
  margin: 0 1px 0 3px;
  vertical-align: super;
  border-radius: 50%;
  background: var(--kk-solid);
}
@keyframes kk-reader-flash {
  0%, 100% { background-color: color-mix(in srgb, var(--kk-solid) 32%, transparent); }
  35%      { background-color: color-mix(in srgb, var(--kk-solid) 78%, transparent); }
}
.${READER_HIGHLIGHT_CLASS}[data-kk-flash='1'] {
  animation: kk-reader-flash 0.55s ease-in-out 2;
}`
}

/**
 * The reader's own stylesheet. It has to be plain CSS inside the frame's
 * document — Tailwind's classes stop at the frame boundary — and it has to
 * carry its own dark mode, which it gets from `prefers-color-scheme` for the
 * same reason the app does (tailwind.config.js sets `darkMode: 'media'`).
 */
function readerStylesheet(): string {
  return `
:root {
  color-scheme: light dark;
  --kk-fg: #262626;
  --kk-muted: #737373;
  --kk-rule: #e5e5e5;
  --kk-surface: #f5f5f5;
  --kk-link: #047857;
}
@media (prefers-color-scheme: dark) {
  :root {
    --kk-fg: #e5e5e5;
    --kk-muted: #a3a3a3;
    --kk-rule: #303030;
    --kk-surface: #1c1c1c;
    --kk-link: #34d399;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body {
  color: var(--kk-fg);
  font: 16px/1.7 -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  padding: 0 0 8px;
  overflow-wrap: break-word;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.6em 0 0.5em; font-weight: 600; }
h1 { font-size: 1.5em; }
h2 { font-size: 1.28em; }
h3 { font-size: 1.12em; }
h4, h5, h6 { font-size: 1em; }
p, ul, ol, dl, pre, blockquote, table, figure { margin: 0 0 1em; }
figure { margin-inline: 0; }
ul, ol { padding-left: 1.4em; }
li { margin: 0.25em 0; }
a { color: var(--kk-link); text-decoration: none; }
a:hover { text-decoration: underline; }
a:not([href]) { color: inherit; cursor: text; }
img { max-width: 100%; height: auto; border-radius: 6px; }
figcaption, small { color: var(--kk-muted); font-size: 0.85em; }
blockquote {
  margin-inline: 0;
  padding: 0.1em 0 0.1em 1em;
  border-left: 3px solid var(--kk-rule);
  color: var(--kk-muted);
}
code, kbd, samp { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
pre {
  background: var(--kk-surface);
  padding: 0.8em 1em;
  border-radius: 8px;
  overflow-x: auto;
}
pre code { font-size: 0.88em; }
hr { border: 0; border-top: 1px solid var(--kk-rule); margin: 2em 0; }
/* Article tables are frequently infoboxes far wider than the pane; let them
   scroll sideways rather than stretch the frame and the pane behind it. */
table { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; font-size: 0.92em; }
th, td { border: 1px solid var(--kk-rule); padding: 0.35em 0.6em; text-align: left; vertical-align: top; }
th { background: var(--kk-surface); }
sup, sub { line-height: 0; }
${highlightRules()}
`
}

/**
 * The complete document handed to the frame's `srcdoc`.
 *
 * `<meta name="referrer" content="no-referrer">` matters more than it looks:
 * the images in a cached article still come off the origin's servers, and
 * without this every one of them would announce which page the reader is on.
 */
export function buildReaderDocument(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<style>${readerStylesheet()}</style>
</head>
<body>${bodyHtml}</body>
</html>`
}
