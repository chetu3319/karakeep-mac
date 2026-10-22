/**
 * Preload script for the live "Web" pane WebContentsView.
 *
 * Two jobs:
 *
 * 1. **Anchoring** — take the highlights Karakeep stores for this bookmark
 *    (plain text + a little surrounding context) and find them again in the
 *    live DOM, which is never byte-identical to whatever the text was
 *    captured from. See `locateText()` / `normalizeWithMap()`.
 * 2. **UI** — a single popover, rendered inside a closed shadow root, that
 *    handles both "I just selected some text" and "I clicked an existing
 *    highlight". Colour, note, copy and delete all live there.
 *
 * Derived from reference/karakeep-extension-content.js (the Karakeep browser
 * extension's highlight content script); the transport is Electron
 * ipcRenderer rather than chrome.runtime, and the matching and UI layers
 * have since been rewritten.
 */
import { ipcRenderer } from 'electron'

import {
  COPY_CONFIRM_MS,
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  ICON_CHECK,
  ICON_COPY,
  ICON_NOTE,
  ICON_STUDY_ATTACH,
  ICON_TRASH,
  highlightPopoverStylesheet,
  normalizeHighlightColor,
  placePopover
} from '../shared/highlightUi'
import { IPC, WEBPANE_IPC } from '../shared/ipc'
import { buildContinueMessages, textAttachment, type InlineMode } from '../shared/inlineAnswer'
import { findQuote } from '../shared/quoteMatch'
import { markdownSegments } from '../shared/safeMarkdown'
import { MAX_REGION_TEXT, isTinyDrag, layoutToVisualRect, rectFromPoints, rectsIntersect, type PxRect } from '../shared/regionCapture'

const HIGHLIGHT_CLASS = 'karakeep-hl'
const OVERLAY_HOST_ID = 'karakeep-hl-overlay'
const STYLE_ID = 'karakeep-hl-styles'

interface StoredHighlight {
  id: string
  text: string
  color: string
  note?: string
  prefix?: string
  suffix?: string
  startOffset: number
  endOffset: number
  highlightId?: string
}

const COLORS = HIGHLIGHT_COLORS
const DEFAULT_COLOR = DEFAULT_HIGHLIGHT_COLOR

/**
 * Styles for the marks themselves. These are the only styles that go into
 * the page's own document — everything else lives in a shadow root (see
 * `ensureOverlay()`), so the page's cascade can't reach it.
 */
function getStylesheet(): string {
  const colorRules = COLORS.map(
    ({ name, hex }) => `
    .${HIGHLIGHT_CLASS}[data-kh-color="${name}"] {
      --kh-solid: ${hex};
      background-color: color-mix(in srgb, ${hex} 32%, transparent) !important;
      box-shadow: inset 0 -1.5px 0 color-mix(in srgb, ${hex} 65%, transparent);
    }
    .${HIGHLIGHT_CLASS}[data-kh-color="${name}"]:hover {
      background-color: color-mix(in srgb, ${hex} 48%, transparent) !important;
    }`
  ).join('\n')

  return `
    .${HIGHLIGHT_CLASS} {
      --kh-solid: ${COLORS[0].hex};
      background-color: color-mix(in srgb, ${COLORS[0].hex} 32%, transparent) !important;
      box-shadow: inset 0 -1.5px 0 color-mix(in srgb, ${COLORS[0].hex} 65%, transparent);
      color: inherit !important;
      border-radius: 2px;
      cursor: pointer;
      padding: 0;
      transition: background-color 0.12s ease;
    }
    ${colorRules}
    /* A note is shown as a small dot in the highlight's own colour rather
       than an emoji — quieter, and it inherits the palette. */
    .${HIGHLIGHT_CLASS}[data-kh-note="1"]::after {
      content: '';
      display: inline-block;
      width: 5px; height: 5px;
      margin: 0 1px 0 3px;
      vertical-align: super;
      border-radius: 50%;
      background: var(--kh-solid);
    }
    .${HIGHLIGHT_CLASS}[data-kh-active="1"] {
      outline: 2px solid var(--kh-solid);
      outline-offset: 1px;
    }
    @keyframes kh-flash {
      0%, 100% { background-color: color-mix(in srgb, var(--kh-solid) 32%, transparent); }
      35%      { background-color: color-mix(in srgb, var(--kh-solid) 75%, transparent); }
    }
    .${HIGHLIGHT_CLASS}[data-kh-flash="1"] {
      animation: kh-flash 0.55s ease-in-out 2;
    }
    /* Study's "jump to this passage" marker: temporary, never a highlight. */
    @keyframes kk-ref-flash {
      0%, 100% { background-color: rgba(255, 224, 102, 0.55); }
      50%      { background-color: rgba(255, 224, 102, 0.95); }
    }
    mark[data-kk-flash] {
      background-color: rgba(255, 224, 102, 0.75) !important;
      color: inherit !important;
      border-radius: 2px;
      animation: kk-ref-flash 0.6s ease-in-out infinite;
    }
  `
}

function karakeepInit(): void {
  const w = window as unknown as { __karakeepHL?: boolean }
  if (w.__karakeepHL) return
  w.__karakeepHL = true

  let pageHighlights: StoredHighlight[] = []
  let lastUsedColor = DEFAULT_COLOR

  function ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = getStylesheet()
    ;(document.head || document.documentElement).appendChild(el)
  }

  function uid(): string {
    return 'kh-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  }

  function sendHost(channel: string, payload: unknown): void {
    ipcRenderer.send(channel, payload)
  }

  function marksFor(id: string): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(`.${HIGHLIGHT_CLASS}[data-kh-id="${id}"]`))
  }

  // ───────────────────────── text collection ─────────────────────────

  // Text inside these never renders as prose, but it *does* sit in the DOM
  // text stream. Including it both shifts offsets and lets a highlight
  // "anchor" somewhere invisible, which reads to the user as a highlight
  // that silently failed.
  const SKIP_TAGS = new Set([
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

  /**
   * Whether an element's text is actually rendered to the reader.
   *
   * Pages routinely carry duplicate copies of the same text for responsive
   * or print layouts (arxiv's `<span class="desktop-only">` is one), hidden
   * with `display: none`. Anchoring into one of those produces a highlight
   * that exists in the DOM, reports itself as anchored, and is completely
   * invisible — which is indistinguishable, to the user, from matching
   * having failed outright. `content-visibility: auto` is deliberately
   * *not* treated as hidden: that content is real, just scrolled offscreen.
   */
  let visibilityCache = new WeakMap<Element, boolean>()

  function isRendered(el: Element): boolean {
    const cached = visibilityCache.get(el)
    if (cached !== undefined) return cached
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
      // their text. Measuring the contents distinguishes those from a
      // genuinely hidden subtree, which measures 0x0.
      try {
        const r = document.createRange()
        r.selectNodeContents(el)
        const rect = r.getBoundingClientRect()
        visible = rect.width > 0 || rect.height > 0
      } catch {
        visible = false
      }
    }
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
        if (parent.closest(`#${OVERLAY_HOST_ID}`)) return NodeFilter.FILTER_REJECT
        if (!node.textContent) return NodeFilter.FILTER_REJECT
        if (!isRendered(parent)) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    let n: Node | null
    while ((n = walker.nextNode())) nodes.push(n as Text)
    return nodes
  }

  // ───────────────────────── normalisation ─────────────────────────

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

  interface Normalized {
    /** Whitespace-collapsed, punctuation-folded text. */
    norm: string
    /** map[i] = index in the source string that norm[i] came from. */
    map: number[]
  }

  /**
   * Collapses whitespace runs to one space, folds smart punctuation, and
   * drops zero-width characters — while keeping an index back to the source
   * for every character kept, so a match found in `norm` can be turned back
   * into a real DOM range. A plain string.replace() can't do that: it loses
   * the correspondence the moment lengths change.
   */
  function normalizeWithMap(src: string): Normalized {
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

  function normalizeNeedle(str: string): string {
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
   * prefix/suffix context.
   */
  function locateText(
    needle: string,
    prefix?: string,
    suffix?: string,
    expectedOffset?: number
  ): Range | null {
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
      const lowerNorm = norm.toLowerCase()
      occurrences = findAll(lowerNorm, normNeedle.toLowerCase())
    }

    if (!occurrences.length && normNeedle.length >= 24) {
      // Head anchor: the opening of the stored text usually survives an edit
      // that changed its tail. Cover only as far as the two actually agree —
      // extending blindly to the stored length would smear the highlight
      // across whatever happens to follow it on the page.
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
      // Highlights that came from the server carry no prefix/suffix at all,
      // so for a short, repeated string like "Abstract" the offset is the
      // only thing distinguishing the right occurrence from the first one.
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
        const distance = useOffset
          ? Math.abs((map[occ.start] ?? occ.start) - (expectedOffset as number))
          : 0
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

  // ───────────────────────── wrapping ─────────────────────────

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
        mark.className = HIGHLIGHT_CLASS
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

  const CONTEXT_LEN = 60

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

  // ───────────────────────── mutations ─────────────────────────

  function bindMark(mark: HTMLElement, hl: StoredHighlight): void {
    mark.addEventListener('click', (e) => {
      // A drag that ended on this mark is a new selection, not a click on
      // the highlight — leave the selection popover alone.
      if (currentSelectionRange()) return
      e.preventDefault()
      e.stopPropagation()
      openHighlightPopover(hl)
    })
  }

  function applyNoteAffordance(id: string, note: string | undefined): void {
    for (const el of marksFor(id)) {
      if (note) {
        el.dataset.khNote = '1'
        el.title = note
      } else {
        delete el.dataset.khNote
        el.removeAttribute('title')
      }
    }
  }

  function createHighlight(range: Range, color: string, withNote: boolean): StoredHighlight | null {
    const text = range.toString().trim()
    if (!text) return null

    const id = uid()
    const context = extractContext(range)
    const startOffset = textOffsetOf(range.startContainer, range.startOffset)
    const endOffset = textOffsetOf(range.endContainer, range.endOffset)
    const marks = wrapRange(range, id, color)
    if (!marks.length) return null

    const hl: StoredHighlight = {
      id,
      text,
      color,
      note: '',
      prefix: context.prefix,
      suffix: context.suffix,
      startOffset,
      endOffset
    }
    pageHighlights.push(hl)
    lastUsedColor = normalizeHighlightColor(color)
    marks.forEach((m) => bindMark(m, hl))

    sendHost('kk:highlight-created', hl)
    reportStatus()

    if (withNote) openHighlightPopover(hl, { note: true })
    return hl
  }

  function setHighlightColor(hl: StoredHighlight, color: string): void {
    if (hl.color === color) return
    hl.color = color
    lastUsedColor = normalizeHighlightColor(color)
    for (const el of marksFor(hl.id)) el.dataset.khColor = color
    sendHost('kk:highlight-updated', hl)
  }

  function setHighlightNote(hl: StoredHighlight, note: string): void {
    hl.note = note
    applyNoteAffordance(hl.id, note || undefined)
    sendHost('kk:highlight-updated', hl)
  }

  function destroyHighlight(id: string): void {
    for (const m of marksFor(id)) {
      const p = m.parentNode
      if (!p) continue
      while (m.firstChild) p.insertBefore(m.firstChild, m)
      p.removeChild(m)
      p.normalize()
    }
    pageHighlights = pageHighlights.filter((h) => h.id !== id)
    sendHost('kk:highlight-removed', { id })
    reportStatus()
  }

  // ───────────────────────── popover ─────────────────────────

  interface Overlay {
    host: HTMLElement
    root: ShadowRoot
  }

  let overlay: Overlay | null = null

  function ensureOverlay(): Overlay {
    if (overlay && overlay.host.isConnected) return overlay
    const host = document.createElement('div')
    host.id = OVERLAY_HOST_ID
    // pointer-events: none so the host never swallows clicks meant for the
    // page; the popover itself opts back in.
    host.style.cssText =
      'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;'
    document.documentElement.appendChild(host)
    const root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = highlightPopoverStylesheet()
    root.appendChild(style)
    overlay = { host, root }
    return overlay
  }

  type PopoverKind = 'selection' | 'highlight'

  interface OpenPopover {
    kind: PopoverKind
    el: HTMLElement
    anchor: () => DOMRect | null
    highlightId?: string
    /** An expanded AI card: it ignores selection changes until dismissed. */
    sticky?: boolean
  }

  let popover: OpenPopover | null = null
  let activeAiHandler: {
    requestId: string
    onChunk: (delta: string) => void
    onDone: (fullText: string) => void
    onError: (error: string) => void
  } | null = null

  ipcRenderer.on(IPC.AI_STREAM_CHUNK_EVENT, (_e, chunk: { requestId: string; delta: string }) => {
    if (activeAiHandler && activeAiHandler.requestId === chunk.requestId) {
      activeAiHandler.onChunk(chunk.delta)
    }
  })
  ipcRenderer.on(IPC.AI_STREAM_DONE_EVENT, (_e, done: { requestId: string; fullText: string }) => {
    if (activeAiHandler && activeAiHandler.requestId === done.requestId) {
      activeAiHandler.onDone(done.fullText)
    }
  })
  ipcRenderer.on(IPC.AI_STREAM_ERROR_EVENT, (_e, err: { requestId: string; error: string }) => {
    if (activeAiHandler && activeAiHandler.requestId === err.requestId) {
      activeAiHandler.onError(err.error)
    }
  })

  function closePopover(): void {
    if (!popover) return
    if (popover.highlightId) {
      for (const el of marksFor(popover.highlightId)) delete el.dataset.khActive
    }
    if (activeAiHandler) void ipcRenderer.invoke(IPC.AI_STREAM_ABORT, activeAiHandler.requestId)
    activeAiHandler = null
    popover.el.remove()
    popover = null
  }


  function reposition(): void {
    if (!popover) return
    const rect = popover.anchor()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      closePopover()
      return
    }
    placePopover(popover.el, rect)
  }

  /**
   * Copies text to the system clipboard from inside an arbitrary bookmarked
   * page's document — not Karakeep's own. `navigator.clipboard` is only
   * defined in a secure context, so it's simply `undefined` on a plain http
   * page; even where it exists, a write can be silently rejected if this
   * webContents isn't the focused one at click time. Both failure modes are
   * invisible to the user (the button just does nothing), which is exactly
   * the bug this exists to avoid — so the primary attempt always falls back
   * to an IPC round-trip into Electron's own `clipboard` module in the main
   * process, which is restricted by neither.
   */
  async function copyToClipboard(text: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return
      }
    } catch {
      // Fall through to the IPC fallback below.
    }
    await ipcRenderer.invoke(IPC.CLIPBOARD_WRITE_TEXT, text)
  }

  function icon(path: string): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.8')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('d', path)
    svg.appendChild(p)
    return svg
  }


  function makeButton(
    label: string,
    iconPath: string,
    onClick: () => void,
    danger = false,
    iconOnly = false,
    // The full set of labels this button will ever show (e.g.
    // ['Copy', 'Copied']). When given, every label is rendered up front in
    // a stacked span (see .kh-btn-label-stack in highlightUi.ts) so the
    // button's width is pinned to the widest of them from the start —
    // swapping the active one with setBtnLabel() below never resizes the
    // button, which is what stops the popover from jumping sideways
    // (placePopover re-centres the whole popover on the anchor every time
    // it's placed, so any child that grows drags the popover with it).
    reserveLabels?: string[]
  ): HTMLElement {
    const b = document.createElement('button')
    b.className = iconOnly ? 'kh-btn kh-icon-only' : 'kh-btn'
    if (danger) b.dataset.danger = '1'
    if (iconPath) b.appendChild(icon(iconPath))
    if (iconOnly) {
      b.title = label
      b.setAttribute('aria-label', label)
    } else if (reserveLabels) {
      const stack = document.createElement('span')
      stack.className = 'kh-btn-label-stack'
      for (const l of reserveLabels) {
        const span = document.createElement('span')
        span.textContent = l
        if (l === label) span.dataset.shown = '1'
        stack.appendChild(span)
      }
      b.appendChild(stack)
    } else {
      const span = document.createElement('span')
      span.textContent = label
      b.appendChild(span)
    }
    b.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onClick()
    })
    return b
  }

  /** Swaps which label is visible in a button built with `reserveLabels`. */
  function setBtnLabel(b: HTMLElement, label: string): void {
    const stack = b.querySelector('.kh-btn-label-stack')
    if (!stack) return
    for (const span of Array.from(stack.children)) {
      const el = span as HTMLElement
      if (el.textContent === label) el.dataset.shown = '1'
      else delete el.dataset.shown
    }
  }

  /** Swaps a button's leading icon (e.g. the copy icon for a checkmark). */
  function setBtnIcon(b: HTMLElement, iconPath: string): void {
    b.querySelector('svg')?.replaceWith(icon(iconPath))
  }

  function makeSwatchRow(active: string | null, onPick: (color: string) => void): HTMLElement {
    const frag = document.createElement('div')
    frag.className = 'kh-row'
    for (const { name, hex } of COLORS) {
      const b = document.createElement('button')
      b.className = 'kh-swatch'
      b.style.backgroundColor = hex
      b.title = name[0].toUpperCase() + name.slice(1)
      b.setAttribute('aria-label', b.title)
      if (active === name) {
        b.dataset.active = '1'
        const check = icon('M5 13l4 4L19 7')
        check.setAttribute('stroke', 'rgba(0,0,0,0.65)')
        check.setAttribute('stroke-width', '3')
        b.appendChild(check)
      }
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        onPick(name)
      })
      frag.appendChild(b)
    }
    return frag
  }

  function newPopoverEl(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'kh-pop'
    // Keep the page selection alive when the popover is clicked, and keep
    // the page's own mousedown handlers out of it.
    el.addEventListener('mousedown', (e) => {
      // The textarea and the note reader own their own selection; everywhere
      // else the default is suppressed so clicking the popover doesn't drop
      // the page selection it was opened for.
      if ((e.target as HTMLElement).closest('.kh-ta, .kh-note-view, .kh-input, .kh-ans')) return
      e.preventDefault()
      e.stopPropagation()
    })
    el.addEventListener('click', (e) => e.stopPropagation())
    return el
  }

  function mountPopover(kind: PopoverKind, el: HTMLElement, anchor: () => DOMRect | null, highlightId?: string): void {
    closePopover()
    const { root } = ensureOverlay()
    root.appendChild(el)
    popover = { kind, el, anchor, highlightId }
    if (highlightId) {
      for (const m of marksFor(highlightId)) m.dataset.khActive = '1'
    }
    const rect = anchor()
    if (rect) placePopover(el, rect)
  }

  const QUICK_ACTIONS: { mode: Exclude<InlineMode, 'custom'>; label: string }[] = [
    { mode: 'micro-explain', label: 'Explain' }
  ]

  /** Replaces the text of a button's label span (the one that is not the icon). */
  function setPlainLabel(b: HTMLElement, label: string): void {
    const span = b.querySelector('span')
    if (span) span.textContent = label
  }

  /**
   * Draws model text into `target` using text nodes and <b> elements only.
   * This runs inside an untrusted page: never build HTML from model output.
   */
  function paintSegments(target: HTMLElement, md: string): void {
    target.textContent = ''
    for (const seg of markdownSegments(md)) {
      if (seg.bold) {
        const b = document.createElement('b')
        b.textContent = seg.text
        target.appendChild(b)
      } else {
        target.appendChild(document.createTextNode(seg.text))
      }
    }
  }

  /**
   * Popover for a fresh text selection. Same toolbar as the PDF reader:
   * swatches, Note, Copy | Explain, Ask..., Add to Study. An AI
   * action grows the same card downward with the answer; from then on the card
   * ignores selection changes and only Esc, a press outside, or an action that
   * finishes with it closes it.
   */
  function openSelectionPopover(range: Range): void {
    const el = newPopoverEl()
    const anchor = (): DOMRect | null => {
      try {
        const r = range.getBoundingClientRect()
        return r.width || r.height ? r : null
      } catch {
        return null
      }
    }

    const selectionText = range.toString().trim()
    // Computed on first use: the selection and its DOM don't change while the
    // card is up, and most selections never reach an AI action.
    let ctx: { surrounding: string; pageText: string } | null = null
    const context = (): { surrounding: string; pageText: string } =>
      (ctx ??= { surrounding: computeSurroundingContext(range), pageText: computePageTextAroundSelection(range) })

    let view: { mode: InlineMode; prompt?: string } | null = null
    let asking = false
    let inputRow: HTMLElement | null = null
    let answerWrap: HTMLElement | null = null
    const modeBtns = new Map<string, HTMLElement>()

    function expand(): void {
      el.className = 'kh-pop kh-ai-mode'
      if (popover?.el === el) popover.sticky = true
    }

    function finish(): void {
      closePopover()
      window.getSelection()?.removeAllRanges()
    }

    function syncToolbar(): void {
      for (const [mode, btn] of modeBtns) {
        const on = mode === 'custom' ? asking || view?.mode === 'custom' : view?.mode === mode
        if (on) btn.dataset.on = '1'
        else delete btn.dataset.on
      }
    }

    const toolbar = document.createElement('div')
    toolbar.className = 'kh-toolbar'

    toolbar.appendChild(
      makeSwatchRow(null, (color) => {
        const clone = range.cloneRange()
        closePopover()
        window.getSelection()?.removeAllRanges()
        createHighlight(clone, color, false)
      })
    )

    const sep = document.createElement('div')
    sep.className = 'kh-sep'
    toolbar.appendChild(sep)

    toolbar.appendChild(
      makeButton('Note', ICON_NOTE, () => {
        const clone = range.cloneRange()
        closePopover()
        window.getSelection()?.removeAllRanges()
        createHighlight(clone, lastUsedColor, true)
      })
    )

    // Copy sits right next to Note, same as it does on an existing
    // highlight's popover.
    const copyBtn = makeButton(
      'Copy',
      ICON_COPY,
      () => {
        const text = range.toString()
        // Nothing was actually copied: no confirmation for a copy that never
        // happened, and nothing to flip back later.
        if (!text) return
        void copyToClipboard(text).catch(() => undefined)
        setBtnIcon(copyBtn, ICON_CHECK)
        setBtnLabel(copyBtn, 'Copied')
        ;(copyBtn as HTMLButtonElement).disabled = true
        setTimeout(() => {
          // Only ever touch the button this closure belongs to.
          if (popover?.el !== el) return
          setBtnIcon(copyBtn, ICON_COPY)
          setBtnLabel(copyBtn, 'Copy')
          ;(copyBtn as HTMLButtonElement).disabled = false
        }, COPY_CONFIRM_MS)
      },
      false,
      false,
      ['Copy', 'Copied']
    )
    toolbar.appendChild(copyBtn)

    const sep2 = document.createElement('div')
    sep2.className = 'kh-sep'
    toolbar.appendChild(sep2)

    for (const a of QUICK_ACTIONS) {
      const b = makeButton(a.label, '', () => startAnswer(a.mode))
      modeBtns.set(a.mode, b)
      toolbar.appendChild(b)
    }
    const askBtn = makeButton('Ask…', '', () => {
      asking = !asking
      renderAsk()
      syncToolbar()
      if (popover?.el === el) reposition()
    })
    modeBtns.set('custom', askBtn)
    toolbar.appendChild(askBtn)

    toolbar.appendChild(
      makeButton(
        'Add to Study',
        ICON_STUDY_ATTACH,
        () => {
          if (!selectionText) return
          sendHost(WEBPANE_IPC.STUDY_ATTACH, textAttachment(selectionText, undefined, context().surrounding))
          // From the expanded card, attaching finishes with it (like the PDF
          // reader); from the bare toolbar the selection is left alone.
          if (popover?.el === el && popover.sticky) finish()
        },
        false,
        true
      )
    )

    el.appendChild(toolbar)

    function renderAsk(): void {
      inputRow?.remove()
      inputRow = null
      if (!asking) return
      expand()
      const row = document.createElement('form')
      row.className = 'kh-ai-input'
      const input = document.createElement('input')
      input.className = 'kh-input'
      input.type = 'text'
      input.placeholder = 'Ask about this selection…'
      input.setAttribute('aria-label', 'Ask about this selection')
      const go = makeButton('Ask', '', () => submit())
      go.className = 'kh-btn kh-primary'
      ;(go as HTMLButtonElement).disabled = true
      const submit = (): void => {
        const q = input.value.trim()
        if (q) startAnswer('custom', q)
      }
      row.addEventListener('submit', (e) => {
        e.preventDefault()
        submit()
      })
      input.addEventListener('input', () => {
        ;(go as HTMLButtonElement).disabled = !input.value.trim()
      })
      // Typing here must not reach the page's own shortcuts. Escape still
      // bubbles so it dismisses the card.
      for (const type of ['keydown', 'keyup', 'keypress'] as const) {
        input.addEventListener(type, (e) => {
          if ((e as KeyboardEvent).key !== 'Escape') e.stopPropagation()
        })
      }
      row.append(input, go)
      toolbar.after(row)
      inputRow = row
      requestAnimationFrame(() => input.focus())
    }

    function startAnswer(mode: InlineMode, prompt?: string): void {
      if (activeAiHandler) void ipcRenderer.invoke(IPC.AI_STREAM_ABORT, activeAiHandler.requestId)
      activeAiHandler = null
      view = { mode, prompt }
      asking = false
      renderAsk()
      syncToolbar()
      expand()
      answerWrap?.remove()

      let text = ''
      let streaming = true
      let error = ''
      let saveState: 'idle' | 'saving' | 'failed' = 'idle'
      let copied = false
      const requestId = `ai-web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

      const wrap = document.createElement('div')
      wrap.className = 'kh-ans-wrap'
      const ans = document.createElement('div')
      ans.className = 'kh-ans kh-ans-plain'
      ans.tabIndex = 0
      const foot = document.createElement('div')
      foot.className = 'kh-ans-foot'

      const copyAns = makeButton('Copy', ICON_COPY, () => {
        if (!text) return
        void copyToClipboard(text).catch(() => undefined)
        copied = true
        paint()
        setTimeout(() => {
          if (popover?.el !== el) return
          copied = false
          paint()
        }, COPY_CONFIRM_MS)
      })
      const saveAns = makeButton('Save as note', ICON_NOTE, () => {
        saveState = 'saving'
        paint()
        const clone = range.cloneRange()
        window.getSelection()?.removeAllRanges()
        const hl = createHighlight(clone, lastUsedColor, false)
        if (!hl) {
          saveState = 'failed'
          paint()
          return
        }
        setHighlightNote(hl, text)
        closePopover()
      })
      const spacer = document.createElement('div')
      spacer.className = 'kh-spacer'
      const stopBtn = makeButton('Stop', '', () => {
        void ipcRenderer.invoke(IPC.AI_STREAM_ABORT, requestId)
        if (activeAiHandler?.requestId === requestId) activeAiHandler = null
        streaming = false
        paint()
      })
      const goBtn = makeButton('Continue in Study', '', () => {
        sendHost(
          WEBPANE_IPC.STUDY_CONTINUE,
          buildContinueMessages({
            mode,
            prompt,
            answer: text,
            attachment: textAttachment(selectionText, undefined, context().surrounding)
          })
        )
        finish()
      })
      goBtn.classList.add('kh-go')
      const arrow = document.createElement('span')
      arrow.setAttribute('aria-hidden', 'true')
      arrow.textContent = '→'
      goBtn.appendChild(arrow)
      foot.append(copyAns, saveAns, spacer, stopBtn, goBtn)
      wrap.append(ans, foot)
      el.appendChild(wrap)
      answerWrap = wrap

      function paint(): void {
        ans.textContent = ''
        if (error) {
          const box = document.createElement('div')
          box.className = 'kh-ans-error'
          const strong = document.createElement('strong')
          strong.textContent = 'Could not get an answer'
          const detail = document.createElement('div')
          detail.textContent = error
          box.append(strong, detail)
          ans.appendChild(box)
        } else {
          if (text) paintSegments(ans, text)
          if (streaming && !text) {
            const hint = document.createElement('span')
            hint.className = 'kh-hint'
            hint.textContent = 'Thinking…'
            ans.appendChild(hint)
          }
          if (streaming && text) {
            const caret = document.createElement('span')
            caret.className = 'kh-caret'
            ans.appendChild(caret)
          }
        }
        const ready = !!text && !streaming && !error
        ;(copyAns as HTMLButtonElement).disabled = !text
        setBtnIcon(copyAns, copied ? ICON_CHECK : ICON_COPY)
        setPlainLabel(copyAns, copied ? 'Copied' : 'Copy')
        ;(saveAns as HTMLButtonElement).disabled = !ready || saveState === 'saving'
        setPlainLabel(
          saveAns,
          saveState === 'saving' ? 'Saving…' : saveState === 'failed' ? 'Save failed, retry' : 'Save as note'
        )
        stopBtn.style.display = streaming ? '' : 'none'
        ;(goBtn as HTMLButtonElement).disabled = !ready
        if (popover?.el === el) reposition()
      }

      activeAiHandler = {
        requestId,
        onChunk: (delta) => {
          text += delta
          paint()
        },
        onDone: (fullText) => {
          text = fullText
          streaming = false
          if (activeAiHandler?.requestId === requestId) activeAiHandler = null
          paint()
        },
        onError: (message) => {
          error = message
          streaming = false
          if (activeAiHandler?.requestId === requestId) activeAiHandler = null
          paint()
        }
      }
      paint()

      const meta = getPageSourceMetadata()
      void ipcRenderer.invoke(IPC.AI_STREAM_START, {
        requestId,
        mode,
        ...(prompt ? { prompt } : {}),
        selectionText,
        surroundingContext: context().surrounding,
        pageText: context().pageText,
        docTitle: document.title,
        sourceUrl: meta.sourceUrl,
        siteName: meta.siteName,
        author: meta.author,
        docKind: 'article'
      })
    }

    mountPopover('selection', el, anchor)
  }

  // ───────────────────────── AI context extraction ─────────────────────────
  // The in-situ HUD used to send `document.body.innerText.slice(0, 3500)` as
  // "page context" and no surrounding-paragraph context at all. For most
  // articles the first 3500 characters of the *document* is nav chrome, a
  // cookie banner, and a byline — never the paragraph the reader actually
  // selected from. Everything below sources context from around the
  // selection instead, which is what the product spec means by "the
  // surrounding sentence or a window of words before and after."

  /** Walks up from a selection node to the nearest block-level ancestor, so context extraction stays within one paragraph/section instead of spanning the whole document. */
  function nearestBlockContainer(node: Node): HTMLElement {
    let el: HTMLElement | null = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
    while (el && el !== document.body) {
      const display = getComputedStyle(el).display
      if (display && display !== 'inline' && display !== 'inline-block' && display !== 'contents') return el
      el = el.parentElement
    }
    return document.body || document.documentElement
  }

  // A raw character-count window almost always starts or ends mid-sentence,
  // which reads as a scrap of text rather than the coherent context the
  // model needs. These trim the *leading* partial sentence off the prefix
  // and the *trailing* partial sentence off the suffix — but only when a
  // real sentence boundary exists reasonably close to the cut, so a prefix
  // that's all one long sentence isn't discarded entirely.
  function trimLeadingPartialSentence(s: string): string {
    const idx = s.search(/[.!?]\s+/)
    return idx >= 0 && idx < 150 ? s.slice(idx + 1).trimStart() : s
  }
  function trimTrailingPartialSentence(s: string): string {
    const candidates = ['. ', '! ', '? ', '.\n', '!\n', '?\n']
    let cut = -1
    for (const c of candidates) {
      const idx = s.lastIndexOf(c)
      if (idx > cut) cut = idx
    }
    return cut >= 0 && cut > s.length - 150 ? s.slice(0, cut + 1) : s
  }

  const SURROUNDING_WINDOW = 400

  /** The immediate paragraph around a selection: up to ~400 chars before and after, snapped to sentence boundaries where one is nearby. */
  function computeSurroundingContext(range: Range): string {
    try {
      const container = nearestBlockContainer(range.startContainer)
      const preRange = document.createRange()
      preRange.setStart(container, 0)
      preRange.setEnd(range.startContainer, range.startOffset)
      const prefix = trimLeadingPartialSentence(preRange.toString().slice(-SURROUNDING_WINDOW))

      const postRange = document.createRange()
      postRange.setStart(range.endContainer, range.endOffset)
      postRange.setEnd(container, container.childNodes.length)
      const suffix = trimTrailingPartialSentence(postRange.toString().slice(0, SURROUNDING_WINDOW))

      return `${prefix} ${range.toString()} ${suffix}`.replace(/\s+/g, ' ').trim()
    } catch {
      return ''
    }
  }

  const PAGE_TEXT_HALF_WINDOW = 1750

  /** Page text centered on the selection rather than sliced from the top of the document — see the section comment above. */
  function computePageTextAroundSelection(range: Range): string {
    const full = document.body?.innerText || ''
    if (!full) return ''
    try {
      const preRange = document.createRange()
      preRange.setStart(document.body, 0)
      preRange.setEnd(range.startContainer, range.startOffset)
      // This is an approximate offset into `full`: Range.toString() and
      // .innerText don't collapse whitespace identically. Good enough to
      // center a window on — exactness isn't the goal, "near the selection
      // rather than the top of the page" is.
      const approxOffset = preRange.toString().length
      const start = Math.max(0, approxOffset - PAGE_TEXT_HALF_WINDOW)
      const end = Math.min(full.length, approxOffset + PAGE_TEXT_HALF_WINDOW)
      return full.slice(start, end)
    } catch {
      return full.slice(0, PAGE_TEXT_HALF_WINDOW * 2)
    }
  }

  /** Website/source metadata the product spec asks be injected alongside the selection — read straight off the live page, which is the one place this app can see it for a `link` bookmark. */
  function getPageSourceMetadata(): { sourceUrl: string; siteName?: string; author?: string } {
    const metaContent = (selector: string): string | undefined =>
      document.querySelector<HTMLMetaElement>(selector)?.content || undefined
    const siteName = metaContent('meta[property="og:site_name"]') || location.hostname
    const author =
      metaContent('meta[name="author"]') ||
      metaContent('meta[property="article:author"]') ||
      metaContent('meta[name="twitter:creator"]')
    return { sourceUrl: location.href, siteName, author }
  }

  /** Popover for an existing highlight: recolour, note, copy, delete. */
  function openHighlightPopover(hl: StoredHighlight, opts: { note?: boolean } = {}): void {
    const el = newPopoverEl()
    const anchor = (): DOMRect | null => {
      const marks = marksFor(hl.id)
      if (!marks.length) return null
      const first = marks[0].getBoundingClientRect()
      const last = marks[marks.length - 1].getBoundingClientRect()
      return new DOMRect(
        Math.min(first.left, last.left),
        Math.min(first.top, last.top),
        Math.max(first.right, last.right) - Math.min(first.left, last.left),
        Math.max(first.bottom, last.bottom) - Math.min(first.top, last.top)
      )
    }

    function accent(): string {
      return COLORS.find((c) => c.name === hl.color)?.hex || COLORS[0].hex
    }

    function copyButton(iconOnly: boolean): HTMLElement {
      // Icon-only buttons carry the long form as a tooltip; the labelled
      // bar has room for the icon to do the explaining.
      return makeButton(
        iconOnly ? 'Copy highlighted text' : 'Copy',
        ICON_COPY,
        () => {
          void navigator.clipboard?.writeText(hl.text).catch(() => undefined)
          closePopover()
        },
        false,
        iconOnly
      )
    }

    function deleteButton(iconOnly: boolean): HTMLElement {
      return makeButton(
        iconOnly ? 'Delete highlight' : 'Delete',
        ICON_TRASH,
        () => {
          const id = hl.id
          closePopover()
          destroyHighlight(id)
        },
        true,
        iconOnly
      )
    }

    function swatches(): HTMLElement {
      return makeSwatchRow(hl.color, (color) => {
        setHighlightColor(hl, color)
        renderActions()
      })
    }

    /**
     * The default view for a highlight. When it carries a note, the note is
     * shown right here in a scrollable block — reading one shouldn't cost a
     * trip through an editor. Editing stays one explicit click away.
     */
    function renderActions(): void {
      el.textContent = ''

      if (hl.note) {
        el.className = 'kh-pop kh-read-mode'

        const note = document.createElement('div')
        note.className = 'kh-note-view'
        note.style.setProperty('--kh-accent', accent())
        note.textContent = hl.note
        // Focusable so the note scrolls with the keyboard, not just the wheel.
        note.tabIndex = 0
        el.appendChild(note)

        const toolbar = document.createElement('div')
        toolbar.className = 'kh-toolbar'
        toolbar.appendChild(swatches())
        const spacer = document.createElement('div')
        spacer.className = 'kh-spacer'
        toolbar.appendChild(spacer)
        toolbar.appendChild(makeButton('Edit', ICON_NOTE, renderNote))
        toolbar.appendChild(copyButton(true))
        toolbar.appendChild(deleteButton(true))
        el.appendChild(toolbar)
      } else {
        el.className = 'kh-pop'
        el.appendChild(swatches())

        const sep = document.createElement('div')
        sep.className = 'kh-sep'
        el.appendChild(sep)

        el.appendChild(makeButton('Note', ICON_NOTE, renderNote))
        el.appendChild(copyButton(false))
        el.appendChild(deleteButton(false))
      }
      reposition()
    }

    function renderNote(): void {
      el.className = 'kh-pop kh-note-mode'
      el.textContent = ''

      const quote = document.createElement('div')
      quote.className = 'kh-quote'
      quote.style.setProperty('--kh-accent', accent())
      quote.textContent = hl.text
      el.appendChild(quote)

      const ta = document.createElement('textarea')
      ta.className = 'kh-ta'
      ta.placeholder = 'Add a note…'
      ta.value = hl.note || ''
      el.appendChild(ta)

      const row = document.createElement('div')
      row.className = 'kh-row'
      const hint = document.createElement('span')
      hint.className = 'kh-hint'
      hint.textContent = '⌘↩ to save'
      row.appendChild(hint)
      const spacer = document.createElement('div')
      spacer.className = 'kh-spacer'
      row.appendChild(spacer)

      const save = (): void => {
        setHighlightNote(hl, ta.value.trim())
        // Back to the reading view rather than dismissing outright: it
        // confirms what was saved, and matches where Cancel lands.
        renderActions()
      }
      row.appendChild(makeButton('Cancel', '', () => renderActions()))
      const saveBtn = makeButton('Save', '', save)
      saveBtn.classList.add('kh-primary')
      row.appendChild(saveBtn)
      el.appendChild(row)

      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          save()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          closePopover()
        }
      })

      reposition()
      // Placed after layout so the popover doesn't jump under the caret.
      requestAnimationFrame(() => {
        ta.focus()
        ta.setSelectionRange(ta.value.length, ta.value.length)
      })
    }

    mountPopover('highlight', el, anchor, hl.id)
    if (opts.note) renderNote()
    else renderActions()
  }

  // ───────────────────────── anchoring / retries ─────────────────────────

  let unresolved: StoredHighlight[] = []
  let anchorObserver: MutationObserver | null = null
  let retryHandle: ReturnType<typeof setTimeout> | null = null
  let observerDebounce: ReturnType<typeof setTimeout> | null = null
  let watchDeadline = 0

  function reportStatus(): void {
    sendHost('kk:highlight-status', {
      anchored: pageHighlights.map((h) => h.id),
      missing: unresolved.map((h) => h.id)
    })
  }

  function stopWatching(): void {
    anchorObserver?.disconnect()
    anchorObserver = null
    if (retryHandle) clearTimeout(retryHandle)
    retryHandle = null
    if (observerDebounce) clearTimeout(observerDebounce)
    observerDebounce = null
  }

  /**
   * Client-rendered pages (and lazily-hydrated ones) often don't have the
   * highlighted text in the DOM at dom-ready at all — the single-shot apply
   * this used to do is a large share of "my highlights don't show up". Keep
   * retrying as the DOM changes, then give up rather than watching forever.
   */
  function startWatching(): void {
    if (!unresolved.length) {
      stopWatching()
      return
    }
    if (!watchDeadline) watchDeadline = Date.now() + 30000

    if (!anchorObserver && document.body) {
      anchorObserver = new MutationObserver(() => {
        if (observerDebounce) clearTimeout(observerDebounce)
        observerDebounce = setTimeout(() => resolvePending(), 300)
      })
      anchorObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
    }
    if (!retryHandle) {
      retryHandle = setTimeout(() => {
        retryHandle = null
        resolvePending()
      }, 1200)
    }
  }

  function resolvePending(): void {
    if (!unresolved.length || Date.now() > watchDeadline) {
      if (unresolved.length) {
        console.warn('[karakeep] gave up anchoring', unresolved.length, 'highlight(s) on this page')
      }
      stopWatching()
      return
    }
    applyStored(unresolved)
  }

  function applyStored(list: StoredHighlight[]): void {
    if (!list || !list.length || !document.body) return
    // Visibility changes as a page hydrates, so the cache only holds for
    // the duration of one pass.
    visibilityCache = new WeakMap<Element, boolean>()
    // Our own wrapping mutates the DOM; don't let that feed back into the
    // observer that triggered us.
    anchorObserver?.disconnect()

    const stillMissing: StoredHighlight[] = []
    let anchoredAny = false

    for (const h of list) {
      if (!h || !h.text) continue
      if (marksFor(h.id).length) continue
      const found = locateText(h.text, h.prefix, h.suffix, h.startOffset)
      if (!found) {
        stillMissing.push(h)
        continue
      }
      const marks = wrapRange(found, h.id, h.color || DEFAULT_COLOR)
      if (!marks.length) {
        stillMissing.push(h)
        continue
      }
      const existing = pageHighlights.find((e) => e.id === h.id)
      const record = existing || h
      if (!existing) pageHighlights.push(record)
      marks.forEach((m) => bindMark(m, record))
      applyNoteAffordance(h.id, h.note || undefined)
      anchoredAny = true
    }

    unresolved = stillMissing
    if (anchorObserver && document.body) {
      anchorObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
    }
    if (unresolved.length) startWatching()
    else stopWatching()
    if (anchoredAny || list.length) reportStatus()
  }

  /**
   * Reconciles the full server-side list for this bookmark against what is
   * currently on the page: anchors anything new, and drops marks for
   * highlights that no longer exist (deleted from the desktop UI).
   */
  function syncHighlights(list: StoredHighlight[]): void {
    const incoming = Array.isArray(list) ? list : []
    const incomingIds = new Set(incoming.map((h) => h.id))

    // An empty list is ambiguous — it's what a failed or still-loading
    // highlights query looks like as well as a genuinely empty bookmark —
    // so it never reaps. Deletions made in this page remove their own marks
    // synchronously, so nothing depends on reaping to stay in step.
    for (const existing of incoming.length ? [...pageHighlights] : []) {
      // Session-created highlights aren't in the server list under their
      // client id yet — never reap those.
      if (existing.id.startsWith('kh-')) continue
      if (incomingIds.has(existing.id)) continue
      for (const m of marksFor(existing.id)) {
        const p = m.parentNode
        if (!p) continue
        while (m.firstChild) p.insertBefore(m.firstChild, m)
        p.removeChild(m)
        p.normalize()
      }
      pageHighlights = pageHighlights.filter((h) => h.id !== existing.id)
    }

    // Pick up colour/note edits made outside the live page.
    for (const h of incoming) {
      const existing = pageHighlights.find((e) => e.id === h.id)
      if (!existing) continue
      if (h.color && h.color !== existing.color) {
        existing.color = h.color
        for (const m of marksFor(h.id)) m.dataset.khColor = h.color
      }
      if ((h.note || '') !== (existing.note || '')) {
        existing.note = h.note || ''
        applyNoteAffordance(h.id, existing.note || undefined)
      }
    }

    watchDeadline = Date.now() + 30000
    applyStored(incoming)
  }

  /**
   * Re-keys a highlight created in this page from its client-generated id to
   * the id the server assigned, so the next full sync recognises it as
   * already anchored instead of highlighting the same text twice.
   */
  function adoptServerId(clientId: string, serverId: string): void {
    if (!clientId || !serverId || clientId === serverId) return
    const hl = pageHighlights.find((h) => h.id === clientId)
    if (!hl) return
    for (const m of marksFor(clientId)) m.dataset.khId = serverId
    hl.id = serverId
    if (popover?.highlightId === clientId) popover.highlightId = serverId
    reportStatus()
  }

  function focusHighlight(id: string): void {
    const marks = marksFor(id)
    if (!marks.length) return
    marks[0].scrollIntoView({ block: 'center', behavior: 'smooth' })
    for (const m of marks) {
      m.dataset.khFlash = '1'
      setTimeout(() => delete m.dataset.khFlash, 1300)
    }
  }

  // ───────────────────────── Study references ─────────────────────────

  const REF_FLASH_MS = 1500
  let refFlashTimer: ReturnType<typeof setTimeout> | null = null

  function clearRefFlash(): void {
    if (refFlashTimer) clearTimeout(refFlashTimer)
    refFlashTimer = null
    for (const m of Array.from(document.querySelectorAll<HTMLElement>('mark[data-kk-flash]'))) {
      const parent = m.parentNode
      if (!parent) continue
      while (m.firstChild) parent.insertBefore(m.firstChild, m)
      parent.removeChild(m)
      parent.normalize()
    }
  }

  /**
   * Finds `quote` in the rendered text and returns a Range over it. The page
   * text is the same text nodes the highlight anchoring walks, joined with a
   * newline wherever the block changes so "end of one paragraph / start of
   * the next" reads like whitespace to findQuote rather than gluing words
   * together. Falls back to the highlight matcher for anything findQuote's
   * stricter normalisation misses.
   */
  function rangeForQuote(quote: string): Range | null {
    const nodes = collectTextNodes()
    if (!nodes.length) return null
    const blockOf = new Map<Element, Element>()
    const blockFor = (n: Text): Element => {
      const parent = n.parentElement as Element
      let b = blockOf.get(parent)
      if (!b) {
        b = nearestBlockContainer(n)
        blockOf.set(parent, b)
      }
      return b
    }
    let full = ''
    const entries: { node: Text; start: number }[] = []
    let prevBlock: Element | null = null
    for (const n of nodes) {
      const block = blockFor(n)
      if (prevBlock && block !== prevBlock) full += '\n'
      prevBlock = block
      entries.push({ node: n, start: full.length })
      full += n.data
    }
    const hit = findQuote(full, quote)
    if (!hit) return locateText(quote)
    let startNode: Text | null = null
    let startOffset = 0
    let endNode: Text | null = null
    let endOffset = 0
    for (const e of entries) {
      const end = e.start + e.node.data.length
      if (!startNode && end > hit.start) {
        startNode = e.node
        startOffset = Math.max(0, hit.start - e.start)
      }
      if (e.start < hit.end) {
        endNode = e.node
        endOffset = Math.min(e.node.data.length, hit.end - e.start)
      }
    }
    if (!startNode || !endNode) return null
    try {
      const range = document.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(endNode, endOffset)
      return range.collapsed ? null : range
    } catch {
      return null
    }
  }

  function revealQuote(quote: string): boolean {
    clearRefFlash()
    const range = rangeForQuote(quote)
    if (!range) return false
    const marks: HTMLElement[] = []
    for (const node of textNodesIn(range)) {
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
        mark.setAttribute('data-kk-flash', '1')
        nr.surroundContents(mark)
        marks.push(mark)
      } catch {
        // A fragment that straddles a non-text node is skipped; the rest still flashes.
      }
    }
    if (!marks.length) return false
    marks[0].scrollIntoView({ block: 'center', behavior: 'smooth' })
    refFlashTimer = setTimeout(clearRefFlash, REF_FLASH_MS)
    return true
  }

  // ───────────────────────── events ─────────────────────────

  let selectionTimer: ReturnType<typeof setTimeout> | null = null

  function currentSelectionRange(): Range | null {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
    if (!sel.toString().trim()) return null
    const range = sel.getRangeAt(0)
    let anchor: Node | null = sel.anchorNode
    if (anchor && anchor.nodeType !== Node.ELEMENT_NODE) anchor = anchor.parentElement
    // Selections inside our own popover (shadow DOM) never reach here as
    // light-DOM nodes, but an editable field on the page shouldn't get a
    // highlight popover either.
    if (anchor && (anchor as Element).closest?.('input, textarea, [contenteditable="true"]')) return null
    return range
  }

  function onSelectionSettled(): void {
    // An expanded AI card keeps its place and its stream whatever the page
    // selection does; only a dismissal closes it.
    if (popover?.sticky) return
    const range = currentSelectionRange()
    if (range) {
      openSelectionPopover(range)
    } else if (popover?.kind === 'selection') {
      closePopover()
    }
  }

  function scheduleSelectionCheck(): void {
    if (selectionTimer) clearTimeout(selectionTimer)
    selectionTimer = setTimeout(onSelectionSettled, 150)
  }

  document.addEventListener('mouseup', (e) => {
    // A press on our own popover — including the AI HUD's mode tabs, which
    // deliberately leave the underlying window selection alone so "Ask AI"
    // and "Note" still have text to act on — must not schedule a selection
    // check. That check would fire 150ms later, find the same selection
    // still live, and call openSelectionPopover() again: closePopover()
    // tears down whatever is showing (the AI HUD, mid-answer) and a bare
    // colour-swatch popover replaces it. That's what made clicking any
    // control inside the AI popover look like the popover just vanishing.
    if (overlay && e.composedPath?.().includes(overlay.host)) return
    // A plain click on an existing highlight opens that highlight's popover
    // instead — don't let the (collapsed) selection check race it. A drag
    // that merely *ends* on a highlight is still a selection, and must
    // still offer to highlight it.
    const onMark = (e.target as Element)?.closest?.(`.${HIGHLIGHT_CLASS}`)
    if (onMark && !currentSelectionRange()) {
      if (selectionTimer) clearTimeout(selectionTimer)
      return
    }
    scheduleSelectionCheck()
  })

  document.addEventListener('keyup', (e) => {
    const selectAll = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a'
    if (e.shiftKey || e.key.startsWith('Arrow') || selectAll) scheduleSelectionCheck()
  })

  document.addEventListener(
    'mousedown',
    (e) => {
      if (!popover) return
      const path = e.composedPath?.() || []
      if (overlay && path.includes(overlay.host)) return
      if ((e.target as Element)?.closest?.(`.${HIGHLIGHT_CLASS}`)) return
      closePopover()
    },
    true
  )

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popover) closePopover()
  })

  let repositionFrame = 0
  function queueReposition(): void {
    if (!popover || repositionFrame) return
    repositionFrame = requestAnimationFrame(() => {
      repositionFrame = 0
      reposition()
    })
  }
  window.addEventListener('scroll', queueReposition, true)
  window.addEventListener('resize', queueReposition)


  // ───────────────────────── region capture ─────────────────────────
  // A crosshair the user drags over a figure or equation. The native view
  // covers the React UI, so this has to live in the page. It is built from
  // elements and inline styles only (no page or model text ever reaches it),
  // inside the same closed shadow root as the toolbar. Esc, a drag under 8px
  // or a navigation cancels; the main process takes the picture, so the layer
  // is removed first and the rectangle is reported in viewport CSS px.

  let captureLayer: { el: HTMLElement; stop: () => void; requestId: string } | null = null

  function endCapture(): void {
    if (!captureLayer) return
    const layer = captureLayer
    captureLayer = null
    layer.stop()
  }

  /** Text of the nodes drawn inside `area`, in document order, bounded. */
  function textWithin(area: PxRect): string {
    const root = document.body
    if (!root) return ''
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    const parts: string[] = []
    let length = 0
    let visited = 0
    let n: Node | null
    while ((n = walker.nextNode()) && length < MAX_REGION_TEXT && visited++ < 40000) {
      const value = n.textContent
      const parent = n.parentElement
      if (!value || !value.trim() || !parent) continue
      if (SKIP_TAGS.has(parent.tagName.toUpperCase()) || parent.closest(`#${OVERLAY_HOST_ID}`)) continue
      range.selectNodeContents(n)
      const bounds = range.getBoundingClientRect()
      if (!rectsIntersect(area, { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height })) continue
      const rects = Array.from(range.getClientRects())
      if (!rects.some((r) => rectsIntersect(area, { x: r.left, y: r.top, width: r.width, height: r.height }))) continue
      parts.push(value.trim())
      length += value.length + 1
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REGION_TEXT)
  }

  function startCapture(requestId: string): void {
    endCapture()
    closePopover()
    const { root } = ensureOverlay()
    const layer = document.createElement('div')
    layer.style.cssText =
      'position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; background: rgba(0,0,0,0.12); touch-action: none; user-select: none;'
    const box = document.createElement('div')
    box.style.cssText =
      'position: fixed; display: none; box-sizing: border-box; border: 1.5px solid #10b981; background: rgba(16,185,129,0.14); border-radius: 2px; pointer-events: none;'
    layer.appendChild(box)
    root.appendChild(layer)

    let start: { x: number; y: number } | null = null
    let rect: PxRect | null = null

    const draw = (): void => {
      if (!rect) return
      box.style.display = 'block'
      box.style.left = rect.x + 'px'
      box.style.top = rect.y + 'px'
      box.style.width = rect.width + 'px'
      box.style.height = rect.height + 'px'
    }
    const report = (r: PxRect | null): void => {
      const text = r ? textWithin(r) : ''
      // capturePage works in the visible area; under pinch zoom that is the
      // visual viewport, so the layout-space drag is mapped into it.
      const vv = window.visualViewport
      const rect =
        r && vv
          ? layoutToVisualRect(r, {
              offsetLeft: vv.offsetLeft,
              offsetTop: vv.offsetTop,
              width: vv.width,
              height: vv.height,
              scale: vv.scale
            })
          : r
      sendHost(WEBPANE_IPC.CAPTURE_RESULT, { requestId, rect, text })
    }
    const finish = (r: PxRect | null): void => {
      endCapture()
      if (!r) return report(null)
      // Two frames: the layer is gone from what the compositor shows before
      // the main process photographs the view.
      requestAnimationFrame(() => requestAnimationFrame(() => report(r)))
    }
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      e.preventDefault()
      layer.setPointerCapture?.(e.pointerId)
      start = { x: e.clientX, y: e.clientY }
      rect = rectFromPoints(start.x, start.y, e.clientX, e.clientY)
      draw()
    }
    const onMove = (e: PointerEvent): void => {
      if (!start) return
      rect = rectFromPoints(start.x, start.y, e.clientX, e.clientY)
      draw()
    }
    const onUp = (e: PointerEvent): void => {
      if (!start) return
      rect = rectFromPoints(start.x, start.y, e.clientX, e.clientY)
      const r = rect
      start = null
      finish(isTinyDrag(r) ? null : r)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      finish(null)
    }
    layer.addEventListener('pointerdown', onDown)
    layer.addEventListener('pointermove', onMove)
    layer.addEventListener('pointerup', onUp)
    layer.addEventListener('pointercancel', () => finish(null))
    layer.addEventListener('contextmenu', (e) => e.preventDefault())
    window.addEventListener('keydown', onKey, true)
    captureLayer = {
      el: layer,
      requestId,
      stop: () => {
        window.removeEventListener('keydown', onKey, true)
        layer.remove()
      }
    }
  }

  ipcRenderer.on(WEBPANE_IPC.CAPTURE_START, (_e, req: { requestId?: string }) => {
    if (typeof req?.requestId === 'string') startCapture(req.requestId)
  })
  ipcRenderer.on(WEBPANE_IPC.CAPTURE_CANCEL, () => endCapture())

  ipcRenderer.on('kk:apply', (_e, highlights: StoredHighlight[]) => {
    ensureStyles()
    syncHighlights(highlights)
  })
  ipcRenderer.on('kk:focus', (_e, id: string) => focusHighlight(id))
  ipcRenderer.on(WEBPANE_IPC.REVEAL_QUOTE, (_e, req: { requestId: string; quote: string }) => {
    let found = false
    try {
      found = typeof req?.quote === 'string' && revealQuote(req.quote)
    } catch {
      found = false
    }
    sendHost(WEBPANE_IPC.REVEAL_RESULT, { requestId: req?.requestId, found })
  })
  ipcRenderer.on('kk:id-assigned', (_e, p: { clientId: string; serverId: string }) => {
    adoptServerId(p.clientId, p.serverId)
  })

  document.addEventListener('DOMContentLoaded', () => ensureStyles())
  ensureStyles()
  sendHost('kk:ready', null)
}

karakeepInit()
