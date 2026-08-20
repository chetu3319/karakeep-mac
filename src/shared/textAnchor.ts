/**
 * Finding a stored highlight's quote again in a body of text.
 *
 * Karakeep stores a highlight as `{ startOffset, endOffset, text }` — two
 * character offsets into "the document text" plus the quote itself. The
 * offsets are only as stable as whatever extraction produced them, and a
 * highlight made by another client never shares our numbering, so the quote
 * is treated as the real anchor and the offsets as a hint. That is the same
 * bargain `renderer/src/lib/pdfAnchor.ts` strikes for PDFs.
 *
 * This module is the text half of that: normalisation, search, and
 * tie-breaking, all over plain strings. The DOM half — turning the returned
 * character span back into a Range over real text nodes — belongs to each
 * caller, because the live web pane and the Preview reader disagree about
 * which nodes even count (the live page has to skip invisible subtrees and
 * its own overlay; the reader document has neither).
 *
 * Callers: `preload/webpane.ts` (live page) and
 * `renderer/src/lib/readerAnchor.ts` (cached reader view).
 */

// Characters that routinely differ between the text Karakeep stored and the
// same text as a page renders it: smart punctuation, the many Unicode
// spaces, and invisible formatting characters.
const FOLD: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '′': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '″': '"',
  '–': '-',
  '—': '-',
  '―': '-',
  '−': '-',
  '…': '...'
}

const INVISIBLE = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad])

function isSpaceCode(code: number): boolean {
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x0c ||
    code === 0x0b ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  )
}

export interface Normalized {
  /** Whitespace-collapsed, punctuation-folded text. */
  norm: string
  /** map[i] = index in the source string that norm[i] came from. */
  map: number[]
}

/**
 * Collapses whitespace runs to one space, folds smart punctuation, and drops
 * zero-width characters — while keeping an index back to the source for
 * every character kept, so a match found in `norm` can be turned back into a
 * real position. A plain string.replace() can't do that: it loses the
 * correspondence the moment lengths change.
 */
export function normalizeWithMap(src: string): Normalized {
  const out: string[] = []
  const map: number[] = []
  let prevSpace = false
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i)
    if (INVISIBLE.has(code)) continue
    if (isSpaceCode(code)) {
      if (prevSpace || out.length === 0) continue
      out.push(' ')
      map.push(i)
      prevSpace = true
      continue
    }
    prevSpace = false
    const folded = FOLD[src[i]]
    if (folded) {
      for (const ch of folded) {
        out.push(ch)
        map.push(i)
      }
    } else {
      out.push(src[i])
      map.push(i)
    }
  }
  // Drop a trailing collapsed space so needles and haystack agree at the tail.
  while (out.length && out[out.length - 1] === ' ') {
    out.pop()
    map.pop()
  }
  return { norm: out.join(''), map }
}

export function normalizeNeedle(str: string): string {
  return normalizeWithMap(str).norm
}

interface Occurrence {
  start: number
  end: number
}

function findAll(haystack: string, needle: string, limit = 64): Occurrence[] {
  const out: Occurrence[] = []
  if (!needle) return out
  let from = 0
  while (out.length < limit) {
    const idx = haystack.indexOf(needle, from)
    if (idx < 0) break
    out.push({ start: idx, end: idx + needle.length })
    from = idx + 1
  }
  return out
}

/** Length of the common run between two strings, compared from the ends. */
function commonTail(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

function commonHead(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/** A half-open [start, end) span of the *source* string handed to `locateQuote`. */
export interface TextSpan {
  start: number
  end: number
}

export interface LocateOptions {
  /** Text immediately before the quote when it was captured, if we have it. */
  prefix?: string
  /** Text immediately after it. */
  suffix?: string
  /** The stored startOffset, used only to break ties between equal matches. */
  expectedOffset?: number
}

/**
 * Finds `needle` in `haystack` and returns its span in the source string.
 *
 * Strategy, in order — each step is a strictly looser match than the last,
 * because a highlight that lands on approximately the right sentence is far
 * better than one that silently doesn't render:
 *   1. exact match on the normalised text
 *   2. case-insensitive match
 *   3. head-anchored match (the stored text's opening survives even when the
 *      tail was edited, truncated, or re-flowed)
 * Ambiguity between several matches is resolved with the stored
 * prefix/suffix context, then with the stored offset.
 */
export function locateQuote(
  haystack: string,
  needle: string,
  { prefix, suffix, expectedOffset }: LocateOptions = {}
): TextSpan | null {
  if (!needle || !haystack) return null

  const { norm, map } = normalizeWithMap(haystack)
  const normNeedle = normalizeNeedle(needle)
  if (!normNeedle) return null

  let occurrences = findAll(norm, normNeedle)

  if (!occurrences.length) {
    const lowerNorm = norm.toLowerCase()
    occurrences = findAll(lowerNorm, normNeedle.toLowerCase())
  }

  if (!occurrences.length && normNeedle.length >= 24) {
    // Head anchor: the opening of the stored text usually survives an edit
    // that changed its tail. Cover only as far as the two actually agree —
    // extending blindly to the stored length would smear the highlight
    // across whatever happens to follow it.
    const headLen = Math.max(20, Math.floor(normNeedle.length * 0.6))
    const lowerNorm = norm.toLowerCase()
    const lowerNeedle = normNeedle.toLowerCase()
    const heads = findAll(lowerNorm, lowerNeedle.slice(0, headLen), 16)
    occurrences = heads.map((o) => ({
      start: o.start,
      end: o.start + commonHead(lowerNorm.slice(o.start, o.start + normNeedle.length), lowerNeedle)
    }))
  }

  if (!occurrences.length) return null

  let best = occurrences[0]
  if (occurrences.length > 1) {
    // Two independent tie-breakers, applied in that order:
    //   1. the surrounding text we captured when the highlight was made
    //   2. how far the candidate sits from the stored character offset
    // Highlights that came from the server carry no prefix/suffix at all, so
    // for a short, repeated string like "Abstract" the offset is the only
    // thing distinguishing the right occurrence from the first one.
    const normPrefix = prefix ? normalizeNeedle(prefix) : ''
    const normSuffix = suffix ? normalizeNeedle(suffix) : ''
    const useOffset = typeof expectedOffset === 'number' && expectedOffset > 0
    let bestScore = -1
    let bestDistance = Infinity
    for (const occ of occurrences) {
      let score = 0
      if (normPrefix) {
        score += commonTail(norm.slice(Math.max(0, occ.start - normPrefix.length), occ.start), normPrefix)
      }
      if (normSuffix) {
        score += commonHead(norm.slice(occ.end, occ.end + normSuffix.length), normSuffix)
      }
      const distance = useOffset ? Math.abs((map[occ.start] ?? occ.start) - (expectedOffset as number)) : 0
      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        bestScore = score
        bestDistance = distance
        best = occ
      }
    }
  }

  // Normalised indices -> source indices.
  if (best.start >= map.length) return null
  const start = map[best.start]
  const end = best.end - 1 < map.length ? map[best.end - 1] + 1 : haystack.length
  if (end <= start) return null
  return { start, end }
}
