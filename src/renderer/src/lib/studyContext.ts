/**
 * Building the document text Study sends to the model.
 *
 * Gemini takes the whole document, but a 300-page book can exceed the request
 * size. When it does, we keep what the question is most likely to need — the
 * opening (title, abstract, contents), the last page, the page being read and
 * the pages the user pointed at, each with a page of neighbours — then spend
 * any budget left on pages nearest those anchors. Gaps are marked so the model
 * knows text is missing rather than guessing it was never there.
 */

export interface DocPage {
  /** 1-based. */
  page: number
  text: string
}

const SEP = '\n\n'
const block = (p: DocPage) => `[[page ${p.page}]]\n${p.text}`
const gapMarker = (from: number, to: number) =>
  from === to ? `[… page ${from} omitted …]` : `[… pages ${from}–${to} omitted …]`

function render(pages: DocPage[], kept: Set<number>): string {
  const parts: string[] = []
  let prev: DocPage | null = null
  for (const p of pages) {
    if (!kept.has(p.page)) continue
    if (prev && p.page > prev.page + 1) parts.push(gapMarker(prev.page + 1, p.page - 1))
    parts.push(block(p))
    prev = p
  }
  const last = pages[pages.length - 1]
  if (prev && last && prev.page < last.page) parts.push(gapMarker(prev.page + 1, last.page))
  return parts.join(SEP)
}

export function assembleDocument(
  input: DocPage[],
  opts: { budget: number; focusPages: number[]; currentPage?: number }
): string {
  const pages = [...input].sort((a, b) => a.page - b.page)
  if (pages.length === 0) return ''

  const all = new Set(pages.map((p) => p.page))
  const full = render(pages, all)
  if (full.length <= opts.budget) return full

  const byPage = new Map(pages.map((p) => [p.page, p]))
  const firstTwo = pages.slice(0, 2).map((p) => p.page)
  const lastPage = pages[pages.length - 1].page
  const anchors = [...new Set([...(opts.currentPage ? [opts.currentPage] : []), ...opts.focusPages])]
    .filter((n) => byPage.has(n))

  // Highest priority first. Tiers 0-1 are never skipped outright; a page that
  // would overflow is cut to fit. Everything after is all-or-nothing.
  const tiers: number[][] = [
    [...firstTwo, lastPage],
    anchors,
    anchors.flatMap((n) => [n - 1, n + 1]),
    // Spare budget goes to whatever is closest to an anchor (or the start).
    [...all].sort((a, b) => dist(a, anchors) - dist(b, anchors) || a - b)
  ]

  const kept = new Set<number>()
  let working = pages // same pages, with any cut-down page swapped in
  let used = ''
  for (let t = 0; t < tiers.length; t++) {
    for (const n of tiers[t]) {
      const p = byPage.get(n)
      if (!p || kept.has(n)) continue
      kept.add(n)
      const next = render(working, kept)
      if (next.length <= opts.budget) {
        used = next
        continue
      }
      if (t > 1) {
        kept.delete(n)
        continue
      }
      // Cut the page's text to what is left, shrinking until it fits (the
      // gap markers around it shift as it joins the set).
      let room = opts.budget - used.length
      let fitted = false
      while (room > 0 && !fitted) {
        const trial = working.map((q) => (q.page === n ? { ...q, text: p.text.slice(0, room) } : q))
        const out = render(trial, kept)
        if (out.length <= opts.budget) {
          working = trial
          used = out
          fitted = true
        } else {
          room -= out.length - opts.budget
        }
      }
      if (!fitted) kept.delete(n)
    }
  }

  return used.slice(0, opts.budget)
}

function dist(page: number, anchors: number[]): number {
  if (anchors.length === 0) return page
  let best = Infinity
  for (const a of anchors) best = Math.min(best, Math.abs(page - a))
  return best
}
