/**
 * Finding stored highlights again in a live page, and wrapping them in marks.
 *
 * Karakeep stores a highlight as its text plus character offsets; the page it
 * is shown on is never byte-identical to whatever the text was captured from.
 * Everything here works on the *rendered* text stream of a document — text
 * nodes that are actually drawn, normalised for the punctuation and
 * whitespace differences that routinely creep in — and maps matches back to
 * real DOM ranges.
 *
 * This is the anchoring core of the desktop app's web-pane preload
 * (src/preload/webpane.ts), lifted out so the Chrome extension's content
 * script runs the same matcher, and so it can be unit tested. It holds no
 * state beyond a per-pass visibility cache and knows nothing about transport
 * or UI.
 */

// Text inside these never renders as prose, but it *does* sit in the DOM
// text stream. Including it both shifts offsets and lets a highlight
// "anchor" somewhere invisible, which reads to the user as a highlight
// that silently failed.
export const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TEXTAREA',
  'TITLE',
  'HEAD',
  'SELECT',
  'OPTION',
  'IFRAME',
  'SVG'
])

// Characters that routinely differ between the text Karakeep stored and
// the same text as the live page renders it: smart punctuation, the many
// Unicode spaces, and invisible formatting characters.
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
 * Collapses whitespace runs to one space, folds smart punctuation, and
 * drops zero-width characters — while keeping an index back to the source
 * for every character kept, so a match found in `norm` can be turned back
 * into a real DOM range.
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

export interface AnchorerOptions {
  /** Class put on every highlight mark. */
  highlightClass: string
  /** Id of the overlay host whose text must never be matched. */
  overlayHostId: string
  /**
   * Whether an element's text is drawn. Defaults to a real visibility check;
   * tests running without layout replace it.
   */
  isRendered?: (el: Element) => boolean
}

export interface Anchorer {
  collectTextNodes(): Text[]
  locateText(needle: string, prefix?: string, suffix?: string, expectedOffset?: number): Range | null
  textNodesIn(range: Range): Text[]
  wrapRange(range: Range, id: string, color: string): HTMLElement[]
  textOffsetOf(node: Node, nodeOffset: number): number
  extractContext(range: Range): { prefix: string; suffix: string }
  marksFor(id: string): HTMLElement[]
  unwrap(marks: HTMLElement[]): void
  /** Visibility changes as a page hydrates; call between anchoring passes. */
  resetVisibilityCache(): void
}

const CONTEXT_LEN = 60

export function createAnchorer(opts: AnchorerOptions): Anchorer {
  const { highlightClass, overlayHostId } = opts
  let visibilityCache = new WeakMap<Element, boolean>()

  /**
   * Whether an element's text is actually rendered to the reader.
   *
   * Pages routinely carry duplicate copies of the same text for responsive
   * or print layouts, hidden with `display: none`. Anchoring into one of
   * those produces a highlight that exists in the DOM and is completely
   * invisible. `content-visibility: auto` is deliberately *not* treated as
   * hidden: that content is real, just scrolled offscreen.
   */
  function defaultIsRendered(el: Element): boolean {
    let visible: boolean
    const check = (el as Element & { checkVisibility?: (o?: unknown) => boolean }).checkVisibility
    if (typeof check === 'function') {
      visible = check.call(el, {
        visibilityProperty: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: false,
        opacityProperty: false,
        checkOpacity: false
      })
    } else {
      visible = el.getClientRects().length > 0
    }
    if (!visible) {
      // checkVisibility() also reports false for an element that simply has
      // no box of its own — `display: contents` wrappers, which do render
      // their text. Measuring the contents tells those apart.
      try {
        const r = document.createRange()
        r.selectNodeContents(el)
        const rect = r.getBoundingClientRect()
        visible = rect.width > 0 || rect.height > 0
      } catch {
        visible = false
      }
    }
    return visible
  }

  const renderedCheck = opts.isRendered ?? defaultIsRendered

  function isRendered(el: Element): boolean {
    const cached = visibilityCache.get(el)
    if (cached !== undefined) return cached
    const visible = renderedCheck(el)
    visibilityCache.set(el, visible)
    return visible
  }

  function collectTextNodes(): Text[] {
    const root = document.body
    if (!root) return []
    const nodes: Text[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node: Node): number {
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        if (SKIP_TAGS.has(parent.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT
        if (parent.closest(`#${overlayHostId}`)) return NodeFilter.FILTER_REJECT
        if (!node.textContent) return NodeFilter.FILTER_REJECT
        if (!isRendered(parent)) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    let n: Node | null
    while ((n = walker.nextNode())) nodes.push(n as Text)
    return nodes
  }

  /**
   * Finds `needle` in the live DOM and returns a Range over it.
   *
   * Strategy, in order — each step is a strictly looser match than the last,
   * because a highlight that lands on approximately the right sentence is
   * far better than one that silently doesn't render:
   *   1. exact match on the normalised text
   *   2. case-insensitive match
   *   3. head-anchored match (the stored text's opening survives even when
   *      the tail was edited, truncated, or re-flowed)
   * Ambiguity between several matches is resolved with the stored
   * prefix/suffix context, then by distance from the stored offset.
   */
  function locateText(needle: string, prefix?: string, suffix?: string, expectedOffset?: number): Range | null {
    if (!needle) return null
    const nodes = collectTextNodes()
    if (!nodes.length) return null

    let full = ''
    const nodeMap: { node: Text; start: number }[] = []
    for (const tn of nodes) {
      nodeMap.push({ node: tn, start: full.length })
      full += tn.data
    }

    const { norm, map } = normalizeWithMap(full)
    const normNeedle = normalizeNeedle(needle)
    if (!normNeedle) return null

    let occurrences = findAll(norm, normNeedle)

    if (!occurrences.length) {
      occurrences = findAll(norm.toLowerCase(), normNeedle.toLowerCase())
    }

    if (!occurrences.length && normNeedle.length >= 24) {
      // Head anchor: cover only as far as the two actually agree — extending
      // blindly to the stored length would smear the highlight across
      // whatever happens to follow it on the page.
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
      // Highlights that came from the server carry no prefix/suffix at all,
      // so for a short, repeated string the offset is the only thing
      // distinguishing the right occurrence from the first one.
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
    // Normalised indices -> source indices -> (node, offset) pairs.
    if (best.start >= map.length) return null
    const srcStart = map[best.start]
    const srcEnd = best.end - 1 < map.length ? map[best.end - 1] + 1 : full.length

    let startNode: Text | null = null
    let startOffset = 0
    let endNode: Text | null = null
    let endOffset = 0
    for (const entry of nodeMap) {
      const nodeEnd = entry.start + entry.node.data.length
      if (!startNode && nodeEnd > srcStart) {
        startNode = entry.node
        startOffset = Math.max(0, srcStart - entry.start)
      }
      if (nodeEnd >= srcEnd) {
        endNode = entry.node
        endOffset = Math.min(entry.node.data.length, srcEnd - entry.start)
        break
      }
    }
    if (!startNode || !endNode) return null

    try {
      const range = document.createRange()
      range.setStart(startNode, Math.min(startOffset, startNode.data.length))
      range.setEnd(endNode, Math.min(endOffset, endNode.data.length))
      if (range.collapsed) return null
      return range
    } catch {
      return null
    }
  }

  function textNodesIn(range: Range): Text[] {
    const start = range.startContainer
    if (start === range.endContainer && start.nodeType === Node.TEXT_NODE) return [start as Text]
    const result: Text[] = []
    const rootNode =
      range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentNode || range.commonAncestorContainer
        : range.commonAncestorContainer
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT)
    let n: Node | null
    while ((n = walker.nextNode())) {
      const parent = (n as Text).parentElement
      if (parent && SKIP_TAGS.has(parent.tagName.toUpperCase())) continue
      if (range.intersectsNode(n)) result.push(n as Text)
    }
    return result
  }

  function wrapRange(range: Range, id: string, color: string): HTMLElement[] {
    const nodes = textNodesIn(range)
    const marks: HTMLElement[] = []
    for (const node of nodes) {
      // The DOM is being mutated as we go; a node that was split or
      // detached by an earlier iteration is no longer wrappable.
      if (!node.isConnected) continue
      const nr = document.createRange()
      try {
        nr.selectNodeContents(node)
        if (node === range.startContainer) nr.setStart(node, Math.min(range.startOffset, node.data.length))
        if (node === range.endContainer) nr.setEnd(node, Math.min(range.endOffset, node.data.length))
      } catch {
        continue
      }
      if (nr.collapsed || !nr.toString().trim()) continue
      try {
        const mark = document.createElement('mark')
        mark.className = highlightClass
        mark.dataset.khId = id
        mark.dataset.khColor = color
        nr.surroundContents(mark)
        marks.push(mark)
      } catch {
        // surroundContents throws when the range partially selects a
        // non-Text node; skipping that fragment still highlights the rest.
      }
    }
    return marks
  }

  function textOffsetOf(node: Node, nodeOffset: number): number {
    let total = 0
    for (const tn of collectTextNodes()) {
      if (tn === node) return total + nodeOffset
      total += tn.data.length
    }
    return -1
  }

  function extractContext(range: Range): { prefix: string; suffix: string } {
    let prefix = ''
    let suffix = ''
    try {
      const preRange = document.createRange()
      preRange.setStart(document.body, 0)
      preRange.setEnd(range.startContainer, range.startOffset)
      prefix = preRange.toString().slice(-CONTEXT_LEN)

      const postRange = document.createRange()
      postRange.setStart(range.endContainer, range.endOffset)
      postRange.setEnd(document.body, document.body.childNodes.length)
      suffix = postRange.toString().slice(0, CONTEXT_LEN)
    } catch {
      // best-effort
    }
    return { prefix, suffix }
  }

  function marksFor(id: string): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(`.${highlightClass}[data-kh-id="${id}"]`))
  }

  function unwrap(marks: HTMLElement[]): void {
    for (const m of marks) {
      const p = m.parentNode
      if (!p) continue
      while (m.firstChild) p.insertBefore(m.firstChild, m)
      p.removeChild(m)
      p.normalize()
    }
  }

  return {
    collectTextNodes,
    locateText,
    textNodesIn,
    wrapRange,
    textOffsetOf,
    extractContext,
    marksFor,
    unwrap,
    resetVisibilityCache: () => {
      visibilityCache = new WeakMap<Element, boolean>()
    }
  }
}
