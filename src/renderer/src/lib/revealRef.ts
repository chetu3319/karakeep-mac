import { findQuoteIn, normalizeForMatch } from '../../../shared/quoteMatch'
import type { AiRef } from './aiRefs'
import { pagesByDistance } from './pdfAnchor'

export type RefQuality = 'exact' | 'approximate' | 'missing'

/**
 * What a click on a tag can come back with. 'unavailable' means the reader or
 * page was not ready (or timed out): nothing was learned about the passage, so
 * the tag keeps whatever it had and stays clickable. Only a confirmed
 * not-found is 'missing'.
 */
export type RevealResult = RefQuality | 'unavailable'

export type NormalizedPage = { flat: string; map: number[] }

export interface LocateOptions {
  /** Normalised pages, shared by every ref resolved against the same document. */
  cache?: Map<number, NormalizedPage>
  /** Give the event loop a turn after normalising a page, so a long PDF doesn't freeze the UI. */
  yieldToLoop?: boolean
}

export type PdfRefLocation =
  | { quality: 'exact' | 'approximate'; page0: number; start?: number; end?: number }
  | { quality: 'missing' }

/**
 * Where a reference points in a PDF. The ladder (spec, settled call 6):
 * the hinted page first, then pages outward from it, then the hinted page
 * with no passage, and only then nothing.
 */
export async function locatePdfRef(
  ref: AiRef,
  pageCount: number,
  pageText: (page0: number) => Promise<string>,
  opts: LocateOptions = {}
): Promise<PdfRefLocation> {
  const normalized = async (page0: number): Promise<NormalizedPage> => {
    const cached = opts.cache?.get(page0)
    if (cached) return cached
    const n = normalizeForMatch(await pageText(page0))
    opts.cache?.set(page0, n)
    if (opts.yieldToLoop) await new Promise((r) => setTimeout(r, 0))
    return n
  }
  if (pageCount <= 0) return { quality: 'missing' }
  const hint = ref.page !== undefined && ref.page >= 1 && ref.page <= pageCount ? ref.page - 1 : undefined
  for (const page0 of pagesByDistance(hint ?? 0, pageCount)) {
    const hit = findQuoteIn(await normalized(page0), ref.quote)
    if (hit) return { quality: 'exact', page0, start: hit.start, end: hit.end }
  }
  return hint !== undefined ? { quality: 'approximate', page0: hint } : { quality: 'missing' }
}

/** Polls until `ready` returns a value, or gives up after `timeoutMs`. */
export async function waitUntil<T>(ready: () => T | null | undefined | false, timeoutMs: number, pollMs = 50): Promise<T | null> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = ready()
    if (v) return v
    if (Date.now() >= end) return null
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/** A tag's quality after a click: only a real answer replaces it; 'unavailable' changes nothing. */
export function applyRevealResult(prev: RefQuality | undefined, result: RevealResult): RefQuality | undefined {
  return result === 'unavailable' ? prev : result
}

/** Resolves after the browser has painted twice, so a just-shown container has real size. */
export function afterPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
}
