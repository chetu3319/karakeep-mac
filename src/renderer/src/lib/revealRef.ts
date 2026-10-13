import { findQuote } from '../../../shared/quoteMatch'
import type { AiRef } from './aiRefs'
import { pagesByDistance } from './pdfAnchor'

export type RefQuality = 'exact' | 'approximate' | 'missing'

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
  pageText: (page0: number) => Promise<string>
): Promise<PdfRefLocation> {
  if (pageCount <= 0) return { quality: 'missing' }
  const hint = ref.page !== undefined && ref.page >= 1 && ref.page <= pageCount ? ref.page - 1 : undefined
  for (const page0 of pagesByDistance(hint ?? 0, pageCount)) {
    const hit = findQuote(await pageText(page0), ref.quote)
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
