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
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  ICON_AI,
  ICON_COPY,
  ICON_NOTE,
  ICON_TRASH,
  highlightPopoverStylesheet,
  placePopover
} from '../shared/highlightUi'
import { IPC } from '../shared/ipc'

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
    lastUsedColor = color
    marks.forEach((m) => bindMark(m, hl))

    sendHost('kk:highlight-created', hl)
    reportStatus()

    if (withNote) openHighlightPopover(hl, { note: true })
    return hl
  }

  function setHighlightColor(hl: StoredHighlight, color: string): void {
    if (hl.color === color) return
    hl.color = color
    lastUsedColor = color
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
  }

  let popover: OpenPopover | null = null

  function closePopover(): void {
    if (!popover) return
    if (popover.highlightId) {
      for (const el of marksFor(popover.highlightId)) delete el.dataset.khActive
    }
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
    iconOnly = false
  ): HTMLElement {
    const b = document.createElement('button')
    b.className = iconOnly ? 'kh-btn kh-icon-only' : 'kh-btn'
    if (danger) b.dataset.danger = '1'
    if (iconPath) b.appendChild(icon(iconPath))
    if (iconOnly) {
      b.title = label
      b.setAttribute('aria-label', label)
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
      if ((e.target as HTMLElement).closest('.kh-ta, .kh-note-view')) return
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

  /** Popover for a fresh text selection: pick a colour, or add a note. */
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

    el.appendChild(
      makeSwatchRow(null, (color) => {
        const clone = range.cloneRange()
        closePopover()
        window.getSelection()?.removeAllRanges()
        createHighlight(clone, color, false)
      })
    )

    const sep = document.createElement('div')
    sep.className = 'kh-sep'
    el.appendChild(sep)

    el.appendChild(
      makeButton('Note', ICON_NOTE, () => {
        const clone = range.cloneRange()
        closePopover()
        window.getSelection()?.removeAllRanges()
        createHighlight(clone, lastUsedColor, true)
      })
    )

    const sep2 = document.createElement('div')
    sep2.className = 'kh-sep'
    el.appendChild(sep2)

    el.appendChild(
      makeButton('Ask AI', ICON_AI, () => {
        const text = range.toString().trim()
        const clone = range.cloneRange()
        openAiPopover(clone, text)
      })
    )

    mountPopover('selection', el, anchor)
  }

  /** In-situ AI Assistant HUD for a web selection: simplify, define term, math decode, save to note. */
  function openAiPopover(range: Range, text: string): void {
    const el = newPopoverEl()
    el.style.cssText =
      'display: flex; flex-direction: column; width: 350px; max-height: 380px; padding: 10px; gap: 8px;'

    const anchor = (): DOMRect | null => {
      try {
        const r = range.getBoundingClientRect()
        return r.width || r.height ? r : null
      } catch {
        return null
      }
    }

    let activeRequestId = `ai-web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    let accumulatedText = ''

    // Header toolbar
    const header = document.createElement('div')
    header.className = 'kh-toolbar'
    header.style.cssText =
      'border-bottom: 1px solid rgba(255,255,255,0.12); padding-bottom: 6px; margin-bottom: 2px;'

    const modes = [
      { id: 'micro-dejargon', label: '⚡ Simplify' },
      { id: 'micro-explain', label: '📖 Term' },
      { id: 'micro-formula', label: '🧮 Math' }
    ]

    const buttons: HTMLElement[] = []
    function startQuery(mode: string): void {
      if (activeRequestId) {
        void ipcRenderer.invoke(IPC.AI_STREAM_ABORT, activeRequestId)
      }
      activeRequestId = `ai-web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      accumulatedText = ''
      body.textContent = 'Thinking with Gemini…'
      saveBtn.style.display = 'none'

      void ipcRenderer.invoke(IPC.AI_STREAM_START, {
        requestId: activeRequestId,
        mode,
        selectionText: text,
        pageText: document.body?.innerText?.slice(0, 3500) || '',
        docTitle: document.title
      })
    }

    modes.forEach(({ id, label }) => {
      const b = document.createElement('button')
      b.className = 'kh-btn'
      b.style.cssText = 'font-size: 11px; padding: 3px 7px; border-radius: 5px;'
      b.textContent = label
      b.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        buttons.forEach((btn) => (btn.style.background = 'transparent'))
        b.style.background = 'rgba(16, 185, 129, 0.25)'
        startQuery(id)
      })
      buttons.push(b)
      header.appendChild(b)
    })
    buttons[0].style.background = 'rgba(16, 185, 129, 0.25)'

    const spacer = document.createElement('div')
    spacer.className = 'kh-spacer'
    header.appendChild(spacer)

    const closeBtn = makeButton(
      'Close',
      'M18 6L6 18M6 6l12 12',
      () => {
        if (activeRequestId) void ipcRenderer.invoke(IPC.AI_STREAM_ABORT, activeRequestId)
        closePopover()
      },
      false,
      true
    )
    header.appendChild(closeBtn)

    el.appendChild(header)

    // Selection preview snippet
    const snippet = document.createElement('div')
    snippet.style.cssText =
      'font-size: 11px; font-style: italic; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 6px; background: rgba(255,255,255,0.06); border-radius: 4px;'
    snippet.textContent = `"${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`
    el.appendChild(snippet)

    // Response body
    const body = document.createElement('div')
    body.className = 'kh-note-view'
    body.style.cssText =
      'flex: 1; max-height: 190px; font-size: 12px; line-height: 1.5; color: #f2f2f7; white-space: pre-wrap;'
    body.textContent = 'Thinking with Gemini…'
    el.appendChild(body)

    // Footer actions
    const footer = document.createElement('div')
    footer.className = 'kh-toolbar'
    footer.style.cssText =
      'border-top: 1px solid rgba(255,255,255,0.12); padding-top: 6px; margin-top: 2px;'

    const saveBtn = makeButton('Save as Note', ICON_NOTE, () => {
      const clone = range.cloneRange()
      closePopover()
      window.getSelection()?.removeAllRanges()
      const hl = createHighlight(clone, lastUsedColor, false)
      if (hl && accumulatedText) setHighlightNote(hl, accumulatedText)
    })
    saveBtn.className = 'kh-btn kh-primary'
    saveBtn.style.cssText = 'font-size: 11px; padding: 3px 8px; font-weight: 500;'
    saveBtn.style.display = 'none'
    footer.appendChild(saveBtn)

    const copyBtn = makeButton('Copy', ICON_COPY, () => {
      if (accumulatedText) void navigator.clipboard?.writeText(accumulatedText)
    })
    copyBtn.style.cssText = 'font-size: 11px; padding: 3px 8px;'
    footer.appendChild(copyBtn)

    el.appendChild(footer)

    // Listeners for AI stream
    const onChunk = (_e: unknown, chunk: { requestId: string; delta: string }): void => {
      if (chunk.requestId === activeRequestId) {
        if (body.textContent === 'Thinking with Gemini…') body.textContent = ''
        accumulatedText += chunk.delta
        body.textContent = accumulatedText
        reposition()
      }
    }

    const onDone = (_e: unknown, done: { requestId: string; fullText: string }): void => {
      if (done.requestId === activeRequestId) {
        accumulatedText = done.fullText
        body.textContent = done.fullText
        saveBtn.style.display = 'inline-flex'
        reposition()
      }
    }

    const onError = (_e: unknown, err: { requestId: string; error: string }): void => {
      if (err.requestId === activeRequestId) {
        body.textContent = `AI Error: ${err.error}`
      }
    }

    ipcRenderer.on(IPC.AI_STREAM_CHUNK_EVENT, onChunk)
    ipcRenderer.on(IPC.AI_STREAM_DONE_EVENT, onDone)
    ipcRenderer.on(IPC.AI_STREAM_ERROR_EVENT, onError)

    mountPopover('selection', el, anchor)
    startQuery('micro-dejargon')
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

  ipcRenderer.on('kk:apply', (_e, highlights: StoredHighlight[]) => {
    ensureStyles()
    syncHighlights(highlights)
  })
  ipcRenderer.on('kk:focus', (_e, id: string) => focusHighlight(id))
  ipcRenderer.on('kk:id-assigned', (_e, p: { clientId: string; serverId: string }) => {
    adoptServerId(p.clientId, p.serverId)
  })

  document.addEventListener('DOMContentLoaded', () => ensureStyles())
  ensureStyles()
  sendHost('kk:ready', null)
}

karakeepInit()
