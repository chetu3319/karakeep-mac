import type { PdfDocumentObject, PdfEngine, PdfPageGeometry } from '@embedpdf/models'

/**
 * Anchoring PDF highlights into Karakeep's highlight model.
 *
 * Karakeep stores a highlight as `{ startOffset, endOffset, text }` — two
 * integer character offsets into "the document text". For an HTML bookmark
 * that text is the crawled reader view. A PDF has no such canonical string,
 * so we define one: the concatenation of every page's text as PDFium extracts
 * it, pages laid end to end. A glyph on page P at index i therefore sits at
 * `pageStarts[P] + i`, and a highlight is the half-open range [start, end).
 *
 * Two things are worth being honest about:
 *
 *  1. These offsets are ours, not the server's. Karakeep runs its own text
 *     extraction over uploaded PDFs (`content.content`), and for at least one
 *     real file in this library that extraction comes back as mojibake — the
 *     font has no usable ToUnicode map for whatever extractor the server uses,
 *     while PDFium reads it fine. Anchoring to the server's string would mean
 *     anchoring to garbage. What does round-trip to every other Karakeep
 *     client is the part that matters to them: the highlighted `text`, the
 *     note, and the colour.
 *
 *  2. Offsets alone are brittle. They are only as stable as the extraction,
 *     and a highlight created by another client won't share our numbering at
 *     all. So the stored `text` is treated as the real anchor and the offsets
 *     as a hint: we verify the quote at the offsets and, when it doesn't
 *     match, search outward for it. Same strategy the Web pane uses for live
 *     DOM, which is where the shape of `resolveAnchor` comes from.
 */

export interface PageIndex {
  /** Global offset at which each page's text begins. */
  pageStarts: number[]
  /** Glyph count per page. */
  pageCounts: number[]
  /** Total glyph count across the document. */
  total: number
}

export interface PageSpan {
  page: number
  /** First glyph index on the page, inclusive. */
  from: number
  /** Last glyph index on the page, inclusive. */
  to: number
}

/** How a stored highlight was located in the document. */
export type AnchorQuality = 'exact' | 'relocated' | 'missing'

export interface ResolvedAnchor {
  spans: PageSpan[]
  quality: AnchorQuality
}

/** Glyph count of a page, derived from its run geometry. */
export function glyphCount(geo: PdfPageGeometry): number {
  let max = 0
  for (const run of geo.runs) {
    const end = run.charStart + run.glyphs.length
    if (end > max) max = end
  }
  return max
}

/**
 * Build the page -> global offset table.
 *
 * This walks every page's geometry, which for a long book is the most
 * expensive thing the pane does. It runs once per document and the result is
 * cached by the caller; `onProgress` exists so the UI can say so.
 */
export async function buildPageIndex(
  engine: PdfEngine,
  doc: PdfDocumentObject,
  onProgress?: (done: number, total: number) => void
): Promise<{ index: PageIndex; geometry: Map<number, PdfPageGeometry> }> {
  const geometry = new Map<number, PdfPageGeometry>()
  const pageStarts: number[] = []
  const pageCounts: number[] = []
  let running = 0

  for (const page of doc.pages) {
    const geo = await engine.getPageGeometry(doc, page).toPromise()
    geometry.set(page.index, geo)
    pageStarts[page.index] = running
    pageCounts[page.index] = glyphCount(geo)
    running += pageCounts[page.index]
    onProgress?.(page.index + 1, doc.pages.length)
  }

  return { index: { pageStarts, pageCounts, total: running }, geometry }
}

/** Global offset for a glyph on a page. */
export function toGlobal(index: PageIndex, page: number, glyph: number): number {
  return (index.pageStarts[page] ?? 0) + glyph
}

/** Split a half-open global range into per-page glyph spans. */
export function spansForRange(index: PageIndex, start: number, end: number): PageSpan[] {
  const spans: PageSpan[] = []
  if (end <= start) return spans

  for (let page = 0; page < index.pageStarts.length; page++) {
    const pageStart = index.pageStarts[page]
    const pageEnd = pageStart + index.pageCounts[page]
    if (pageEnd <= start) continue
    if (pageStart >= end) break
    const from = Math.max(start, pageStart) - pageStart
    const to = Math.min(end, pageEnd) - pageStart - 1
    if (to >= from) spans.push({ page, from, to })
  }
  return spans
}

/** Text of a per-page span, straight from PDFium. */
export async function textForSpans(
  engine: PdfEngine,
  doc: PdfDocumentObject,
  spans: PageSpan[]
): Promise<string> {
  if (spans.length === 0) return ''
  const parts = await engine
    .getTextSlices(
      doc,
      spans.map((s) => ({ pageIndex: s.page, charIndex: s.from, charCount: s.to - s.from + 1 }))
    )
    .toPromise()
  return parts.join('')
}

/**
 * Whitespace-insensitive comparison key. PDFium hands back the line breaks
 * that are baked into the page layout, so a quote re-read from a different
 * offset can differ from the stored one by nothing but a newline.
 */
export function normalizeQuote(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Locate a stored highlight in the document.
 *
 * The offsets are tried first. If the text there isn't the stored quote, the
 * quote is searched for — starting on the page the offsets point at, then
 * fanning outward, so a highlight that moved by a paragraph is found before
 * an identical sentence twenty pages away.
 */
export async function resolveAnchor(
  engine: PdfEngine,
  doc: PdfDocumentObject,
  index: PageIndex,
  pageText: (page: number) => Promise<string>,
  highlight: { startOffset: number; endOffset: number; text?: string | null }
): Promise<ResolvedAnchor> {
  const quote = (highlight.text || '').trim()
  const start = Math.max(0, Math.min(highlight.startOffset, index.total))
  const end = Math.max(start, Math.min(highlight.endOffset, index.total))

  const direct = spansForRange(index, start, end)
  if (direct.length > 0) {
    if (!quote) return { spans: direct, quality: 'exact' }
    const found = await textForSpans(engine, doc, direct)
    if (normalizeQuote(found) === normalizeQuote(quote)) return { spans: direct, quality: 'exact' }
  }

  if (!quote) return { spans: [], quality: 'missing' }

  const hintPage = direct[0]?.page ?? 0
  for (const page of pagesByDistance(hintPage, index.pageStarts.length)) {
    const text = await pageText(page)
    const at = indexOfNormalized(text, quote)
    if (at < 0) continue
    const globalStart = index.pageStarts[page] + at
    const spans = spansForRange(index, globalStart, globalStart + quote.length)
    if (spans.length > 0) return { spans, quality: 'relocated' }
  }

  return { spans: [], quality: 'missing' }
}

/** Page numbers ordered by distance from `from`: 3, 2, 4, 1, 5, ... */
function pagesByDistance(from: number, total: number): number[] {
  const out: number[] = []
  for (let d = 0; d < total; d++) {
    if (from - d >= 0) out.push(from - d)
    if (d > 0 && from + d < total) out.push(from + d)
  }
  return out
}

/**
 * Whitespace-insensitive `indexOf` that reports the offset in the *original*
 * string, so the hit can be turned back into glyph indices.
 */
function indexOfNormalized(haystack: string, needle: string): number {
  const direct = haystack.indexOf(needle)
  if (direct >= 0) return direct

  const map: number[] = []
  let flat = ''
  let pendingSpace = false
  for (let i = 0; i < haystack.length; i++) {
    const ch = haystack[i]
    if (/\s/.test(ch)) {
      pendingSpace = flat.length > 0
      continue
    }
    if (pendingSpace) {
      flat += ' '
      map.push(i)
      pendingSpace = false
    }
    flat += ch.toLowerCase()
    map.push(i)
  }

  const hit = flat.indexOf(normalizeQuote(needle))
  return hit < 0 ? -1 : map[hit]
}
