import { locateQuote } from '../../../shared/textAnchor'
import type { Highlight } from '../../../shared/types'
import { READER_HIGHLIGHT_CLASS } from './readerContent'

/**
 * Placing Karakeep's highlights into the cached reader view.
 *
 * The reader HTML is the closest thing a link bookmark has to a canonical
 * text: it's what Karakeep's own reader pass produced, it's stored, and it
 * doesn't change under us the way the live page does. That makes it a much
 * better target for a stored highlight than the live DOM — but only a better
 * one, not a perfect one, because a highlight may have been created against
 * the live page (by the browser extension, or by this app's Web pane) and
 * carry offsets that mean nothing here. So the matching is the same bargain
 * as everywhere else in this app: the quote is the anchor, the offsets are a
 * hint. See shared/textAnchor.ts.
 */

/** Elements whose text is not part of the article. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE'])

interface TextEntry {
  node: Text
  /** Offset of this node's text within the concatenated document text. */
  start: number
}

function collectTextNodes(doc: Document): TextEntry[] {
  const body = doc.body
  if (!body) return []
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (SKIP_TAGS.has(parent.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT
      if (!node.textContent) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  const entries: TextEntry[] = []
  let offset = 0
  let n: Node | null
  while ((n = walker.nextNode())) {
    const text = n as Text
    entries.push({ node: text, start: offset })
    offset += text.data.length
  }
  return entries
}

/** Undo a previous `applyHighlights`, leaving the article's own DOM as it was. */
export function clearHighlights(doc: Document): void {
  const marks = doc.querySelectorAll(`.${READER_HIGHLIGHT_CLASS}`)
  for (const mark of Array.from(marks)) {
    const parent = mark.parentNode
    if (!parent) continue
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
  }
  // Wrapping splits text nodes; un-wrapping has to put them back together or
  // the next pass sees a quote chopped across a dozen siblings.
  doc.body?.normalize()
}

interface Placement {
  highlight: Highlight
  start: number
  end: number
}

/**
 * Wraps each located highlight in a `<mark>`.
 *
 * Returns the ids that were actually placed, in document order — the Preview
 * tab uses that to say "this one isn't in the reader text" rather than
 * quietly showing a highlight that leads nowhere.
 */
export function applyHighlights(doc: Document, highlights: Highlight[]): string[] {
  clearHighlights(doc)
  const entries = collectTextNodes(doc)
  if (!entries.length) return []

  const full = entries.map((e) => e.node.data).join('')

  const placements: Placement[] = []
  for (const highlight of highlights) {
    const quote = (highlight.text || '').trim()
    if (!quote) continue
    const span = locateQuote(full, quote, { expectedOffset: highlight.startOffset })
    if (!span) continue
    placements.push({ highlight, start: span.start, end: span.end })
  }

  placements.sort((a, b) => a.start - b.start || b.end - a.end)

  // Overlaps can't both be wrapped — one mark would have to live inside the
  // other's text — and the shorter of two overlapping quotes is the one more
  // likely to have matched by accident, so the first (longest at this start)
  // wins and the other is reported as unplaced.
  const accepted: Placement[] = []
  let reach = -1
  for (const p of placements) {
    if (p.start < reach) continue
    accepted.push(p)
    reach = p.end
  }

  // Back to front: wrapping splits text nodes, and every split lands after
  // the ranges we haven't wrapped yet, so their offsets stay valid.
  for (let i = accepted.length - 1; i >= 0; i--) {
    wrap(doc, entries, accepted[i])
  }

  return accepted.map((p) => p.highlight.id)
}

function wrap(doc: Document, entries: TextEntry[], placement: Placement): void {
  const { highlight, start, end } = placement

  const firstIndex = entries.findIndex((e) => e.start + e.node.data.length > start)
  if (firstIndex < 0) return
  let lastIndex = firstIndex
  while (lastIndex + 1 < entries.length && entries[lastIndex].start + entries[lastIndex].node.data.length < end) {
    lastIndex++
  }

  // Collect the pieces first, then wrap: splitting as we go would leave the
  // loop walking nodes it had already re-parented.
  const pieces: Text[] = []
  for (let i = firstIndex; i <= lastIndex; i++) {
    const entry = entries[i]
    let node = entry.node
    const nodeStart = entry.start
    const from = Math.max(0, start - nodeStart)
    const to = Math.min(node.data.length, end - nodeStart)
    if (to <= from) continue
    if (to < node.data.length) node.splitText(to)
    if (from > 0) node = node.splitText(from)
    pieces.push(node)
  }

  pieces.forEach((piece, i) => {
    const parent = piece.parentNode
    if (!parent) return
    const mark = doc.createElement('mark')
    mark.className = READER_HIGHLIGHT_CLASS
    mark.setAttribute('data-kk-id', highlight.id)
    mark.setAttribute('data-kk-color', highlight.color || '')
    if (highlight.note) {
      // A quote that crosses links and emphasis is wrapped in as many marks
      // as it crosses text nodes — a Wikipedia paragraph can be two dozen.
      // The note's dot goes on the last one only, or the sentence ends up
      // pockmarked with a dot after every link.
      if (i === pieces.length - 1) mark.setAttribute('data-kk-note', '1')
      mark.setAttribute('title', highlight.note)
    }
    parent.insertBefore(mark, piece)
    mark.appendChild(piece)
  })
}

/** The marks belonging to one highlight, in document order. */
export function marksFor(doc: Document, highlightId: string): HTMLElement[] {
  const escaped = highlightId.replace(/["\\]/g, '\\$&')
  return Array.from(doc.querySelectorAll<HTMLElement>(`[data-kk-id="${escaped}"]`))
}

/** Flash a highlight, the way the Web and PDF panes do when one is focused. */
export function flashMark(mark: HTMLElement): () => void {
  mark.setAttribute('data-kk-flash', '1')
  const timer = window.setTimeout(() => mark.removeAttribute('data-kk-flash'), 1200)
  return () => window.clearTimeout(timer)
}
