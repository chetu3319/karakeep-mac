/**
 * References in model output.
 *
 * The model cites the document with inline markers:
 *   [[ref p=4 "quote"]]   [[ref fig p=4 "quote"]]   [[ref "quote"]]
 * (the last form has no page, for web content). The UI turns each into a
 * clickable chip. Model output is untrusted and arrives token by token, so the
 * parser's one hard rule is that raw marker syntax is never shown: unfinished
 * markers are hidden while streaming, and broken ones are dropped.
 */

export interface AiRef {
  index: number
  quote: string
  page?: number
  figure: boolean
}

export type RefSegment = { type: 'text'; text: string } | { type: 'ref'; ref: AiRef }

const OPEN = '[[ref'
const BODY = /^((?:\s+(?:fig|p=\d+))*)\s+"([\s\S]*)"\s*$/

function parseBody(inner: string): Omit<AiRef, 'index'> | null {
  const m = BODY.exec(inner)
  if (!m) return null
  const quote = m[2].trim()
  if (!quote) return null
  const page = /\bp=(\d+)/.exec(m[1])
  return { quote, page: page ? Number(page[1]) : undefined, figure: /\bfig\b/.test(m[1]) }
}

/** Length of the longest suffix of `s` that is a proper prefix of `[[ref`. */
function partialOpenerLength(s: string): number {
  for (let n = Math.min(OPEN.length - 1, s.length); n > 0; n--) {
    if (OPEN.startsWith(s.slice(s.length - n))) return n
  }
  return 0
}

export function parseRefs(text: string, opts: { streaming?: boolean } = {}): RefSegment[] {
  const out: RefSegment[] = []
  const pushText = (t: string) => {
    if (!t) return
    const last = out[out.length - 1]
    if (last && last.type === 'text') last.text += t
    else out.push({ type: 'text', text: t })
  }

  let index = 0
  let pos = 0
  while (pos < text.length) {
    const open = text.indexOf(OPEN, pos)
    if (open < 0) {
      let rest = text.slice(pos)
      if (opts.streaming) rest = rest.slice(0, rest.length - partialOpenerLength(rest))
      pushText(rest)
      break
    }
    pushText(text.slice(pos, open))
    const close = text.indexOf(']]', open)
    if (close < 0) break // unfinished: hidden while streaming, dropped after

    const parsed = parseBody(text.slice(open + OPEN.length, close))
    if (parsed) out.push({ type: 'ref', ref: { index: index++, ...parsed } })
    pos = close + 2
  }
  return out
}

export function refLabel(ref: AiRef, paged: boolean): string {
  if (!paged || ref.page === undefined) return String(ref.index + 1)
  return ref.figure ? `Fig. · p.${ref.page}` : `p.${ref.page}`
}
