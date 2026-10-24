/**
 * Content script: shows a saved page's Karakeep highlights in the live tab,
 * and is where new highlights, notes and AI answers are made.
 *
 * This is the desktop app's web-pane preload (src/preload/webpane.ts) brought
 * to the browser, with the same marks, the same popover and the same
 * anchoring (src/shared/pageAnchor.ts). What differs:
 *
 * - Transport is chrome.runtime to the service worker rather than Electron
 *   IPC; the worker is the only side holding the API key.
 * - The selection toolbar does not appear on every text selection. It opens
 *   when the user asks for it — "Highlight with Karakeep" in the context
 *   menu, or the keyboard shortcut — because on the open web most
 *   selections are copy/paste, not highlighting.
 * - There is no Study panel in the browser, so the toolbar's AI actions end
 *   in Copy or Save as note instead of Add to Study / Continue in Study.
 */
import {
  COPY_CONFIRM_MS,
  DEFAULT_HIGHLIGHT_COLOR,
  HIGHLIGHT_COLORS,
  ICON_CHECK,
  ICON_COPY,
  ICON_NOTE,
  ICON_TRASH,
  highlightPopoverStylesheet,
  normalizeHighlightColor,
  placePopover
} from '../../src/shared/highlightUi'
import type { InlineMode } from '../../src/shared/inlineAnswer'
import { createAnchorer } from '../../src/shared/pageAnchor'
import { markdownSegments } from '../../src/shared/safeMarkdown'
import type { AiStreamRequest, Highlight } from '../../src/shared/types'
import {
  AI_PORT,
  send,
  type AiPortOut,
  type CreatedHighlight,
  type PageInit,
  type TabMessage
} from './messages'

/** 'closed' in every real build; see build.mjs for the one exception. */
declare const __KK_SHADOW_MODE__: ShadowRootMode

const HIGHLIGHT_CLASS = 'karakeep-hl'
const OVERLAY_HOST_ID = 'karakeep-hl-overlay'
const STYLE_ID = 'karakeep-hl-styles'

interface PageHighlight {
  id: string
  text: string
  color: string
  note?: string
  prefix?: string
  suffix?: string
  startOffset: number
  endOffset: number
}

const COLORS = HIGHLIGHT_COLORS

/** Mark styles: the only styles that go into the page's own document. */
function markStylesheet(): string {
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

/** Extension-only additions to the shared popover stylesheet. */
const EXTRA_OVERLAY_STYLES = `
  .kh-toast {
    position: fixed; right: 16px; bottom: 16px;
    pointer-events: auto;
    display: flex; align-items: center; gap: 8px;
    padding: 9px 14px 9px 10px;
    border-radius: 10px;
    background: rgba(32,32,35,0.94);
    box-shadow: 0 10px 30px rgba(0,0,0,0.32), 0 0 0 0.5px rgba(255,255,255,0.14);
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: #f2f2f7;
    max-width: 360px;
  }
  .kh-toast-dot { width: 18px; height: 18px; border-radius: 50%; background: #059669; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
  .kh-toast-dot svg { width: 11px; height: 11px; }
  .kh-brand { display: flex; align-items: center; padding: 0 6px 0 4px; color: rgba(242,242,247,0.55); font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
`

function karakeepInit(): void {
  const w = window as unknown as { __karakeepExt?: boolean }
  if (w.__karakeepExt) return
  w.__karakeepExt = true

  const anchorer = createAnchorer({ highlightClass: HIGHLIGHT_CLASS, overlayHostId: OVERLAY_HOST_ID })
  const { marksFor } = anchorer

  let pageHighlights: PageHighlight[] = []
  let lastUsedColor: string = DEFAULT_HIGHLIGHT_COLOR
  /** Server-id promises for highlights created on this page, by client id. */
  const pendingIds = new Map<string, Promise<string>>()

  function ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = markStylesheet()
    ;(document.head || document.documentElement).appendChild(el)
  }

  function uid(): string {
    return 'kh-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  }

  /** The server id for a highlight, waiting for its creation if it's still in flight. */
  async function serverIdOf(id: string): Promise<string> {
    return pendingIds.get(id) ?? id
  }

  // ───────────────────────── mutations ─────────────────────────

  function bindMark(mark: HTMLElement, hl: PageHighlight): void {
    mark.addEventListener('click', (e) => {
      // A drag that ended on this mark is a new selection, not a click on
      // the highlight.
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

  function createHighlight(range: Range, color: string, opts: { openNote?: boolean; note?: string } = {}): PageHighlight | null {
    const text = range.toString().trim()
    if (!text) return null

    ensureStyles()
    const id = uid()
    const context = anchorer.extractContext(range)
    const startOffset = anchorer.textOffsetOf(range.startContainer, range.startOffset)
    const endOffset = anchorer.textOffsetOf(range.endContainer, range.endOffset)
    const marks = anchorer.wrapRange(range, id, color)
    if (!marks.length) return null

    const hl: PageHighlight = {
      id,
      text,
      color,
      note: opts.note ?? '',
      prefix: context.prefix,
      suffix: context.suffix,
      startOffset,
      endOffset
    }
    pageHighlights.push(hl)
    lastUsedColor = normalizeHighlightColor(color)
    marks.forEach((m) => bindMark(m, hl))
    if (hl.note) applyNoteAffordance(id, hl.note)

    const created = send<CreatedHighlight>({
      type: 'highlight:create',
      url: location.href,
      title: document.title,
      highlight: { text, color, note: hl.note || '', startOffset: Math.max(0, startOffset), endOffset: Math.max(0, endOffset) }
    })
    const serverId = created.then((r) => r.serverId)
    pendingIds.set(id, serverId)
    created.then(
      (r) => {
        pendingIds.delete(id)
        adoptServerId(id, r.serverId)
        if (r.createdBookmark) showToast('Saved this page to Karakeep')
      },
      (err: unknown) => {
        // Nothing was stored, so nothing may stay on the page claiming it was.
        pendingIds.delete(id)
        removeLocal(hl.id)
        showToast(`Couldn't save the highlight. ${err instanceof Error ? err.message : String(err)}`, false)
      }
    )

    if (opts.openNote) openHighlightPopover(hl, { note: true })
    return hl
  }

  function syncFailed(what: string): (err: unknown) => void {
    return (err) => showToast(`Couldn't ${what}. ${err instanceof Error ? err.message : String(err)}`, false)
  }

  function setHighlightColor(hl: PageHighlight, color: string): void {
    if (hl.color === color) return
    hl.color = color
    lastUsedColor = normalizeHighlightColor(color)
    for (const el of marksFor(hl.id)) el.dataset.khColor = color
    void serverIdOf(hl.id)
      .then((id) => send({ type: 'highlight:update', id, color }))
      .catch(syncFailed('change the colour'))
  }

  function setHighlightNote(hl: PageHighlight, note: string): void {
    hl.note = note
    applyNoteAffordance(hl.id, note || undefined)
    void serverIdOf(hl.id)
      .then((id) => send({ type: 'highlight:update', id, note }))
      .catch(syncFailed('save the note'))
  }

  function removeLocal(id: string): void {
    anchorer.unwrap(marksFor(id))
    pageHighlights = pageHighlights.filter((h) => h.id !== id)
  }

  function destroyHighlight(id: string): void {
    removeLocal(id)
    void serverIdOf(id)
      .then((serverId) => send({ type: 'highlight:delete', id: serverId }))
      .catch(syncFailed('delete the highlight'))
  }

  function adoptServerId(clientId: string, serverId: string): void {
    if (!clientId || !serverId || clientId === serverId) return
    const hl = pageHighlights.find((h) => h.id === clientId)
    if (!hl) return
    for (const m of marksFor(clientId)) m.dataset.khId = serverId
    hl.id = serverId
    if (popover?.highlightId === clientId) popover.highlightId = serverId
  }

  // ───────────────────────── overlay ─────────────────────────

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
    // page; the popover itself opts back in. Hung off <html>, not <body>,
    // which page frameworks transform most often — see highlightUi.ts.
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;'
    document.documentElement.appendChild(host)
    const root = host.attachShadow({ mode: __KK_SHADOW_MODE__ })
    const style = document.createElement('style')
    style.textContent = highlightPopoverStylesheet() + EXTRA_OVERLAY_STYLES
    root.appendChild(style)
    overlay = { host, root }
    return overlay
  }

  let toastEl: HTMLElement | null = null
  let toastTimer: ReturnType<typeof setTimeout> | null = null

  function showToast(text: string, success = true): void {
    const { root } = ensureOverlay()
    toastEl?.remove()
    if (toastTimer) clearTimeout(toastTimer)
    const el = document.createElement('div')
    el.className = 'kh-toast'
    el.setAttribute('role', 'status')
    const dot = document.createElement('span')
    dot.className = 'kh-toast-dot'
    if (!success) dot.style.background = '#ef4444'
    const mark = icon(success ? ICON_CHECK : 'M12 8v5M12 16.5v.01')
    mark.setAttribute('stroke', '#fff')
    mark.setAttribute('stroke-width', '3')
    dot.appendChild(mark)
    const label = document.createElement('span')
    label.textContent = text
    el.append(dot, label)
    root.appendChild(el)
    toastEl = el
    toastTimer = setTimeout(() => {
      el.remove()
      if (toastEl === el) toastEl = null
    }, success ? 2600 : 5000)
  }

  // ───────────────────────── popover ─────────────────────────

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
  let aiPort: chrome.runtime.Port | null = null

  function stopAi(): void {
    aiPort?.disconnect()
    aiPort = null
  }

  function closePopover(): void {
    if (!popover) return
    if (popover.highlightId) {
      for (const el of marksFor(popover.highlightId)) delete el.dataset.khActive
    }
    stopAi()
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

  async function copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // A plain-http page has no async clipboard; the legacy path still works
      // inside the click that asked for it.
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;opacity:0;'
      document.documentElement.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
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
    // Every label this button will ever show, rendered up front so swapping
    // between them never resizes the button (and so never shifts the
    // popover, which placePopover re-centres on each render).
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

  function setBtnLabel(b: HTMLElement, label: string): void {
    const stack = b.querySelector('.kh-btn-label-stack')
    if (!stack) return
    for (const span of Array.from(stack.children)) {
      const el = span as HTMLElement
      if (el.textContent === label) el.dataset.shown = '1'
      else delete el.dataset.shown
    }
  }

  function setBtnIcon(b: HTMLElement, iconPath: string): void {
    b.querySelector('svg')?.replaceWith(icon(iconPath))
  }

  function setPlainLabel(b: HTMLElement, label: string): void {
    const span = b.querySelector('span')
    if (span) span.textContent = label
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
    // the page's own mousedown handlers out of it. Fields that own their
    // own selection are left alone.
    el.addEventListener('mousedown', (e) => {
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

  /** Draws model text with text nodes and <b> only: never HTML from model output. */
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

  /** Stops typing in a popover field from reaching the page's own shortcuts. Escape still bubbles. */
  function isolateKeys(input: HTMLElement): void {
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      input.addEventListener(type, (e) => {
        if ((e as KeyboardEvent).key !== 'Escape') e.stopPropagation()
      })
    }
  }

  /**
   * The selection toolbar, same as the desktop reader's: swatches, Note,
   * Copy | Explain, Ask…. An AI action grows the card downward with the
   * answer; from then on only Esc, a press outside, or an action that
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
        createHighlight(clone, color)
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
        createHighlight(clone, lastUsedColor, { openNote: true })
      })
    )

    const copyBtn = makeButton(
      'Copy',
      ICON_COPY,
      () => {
        const text = range.toString()
        if (!text) return
        void copyToClipboard(text).catch(() => undefined)
        setBtnIcon(copyBtn, ICON_CHECK)
        setBtnLabel(copyBtn, 'Copied')
        ;(copyBtn as HTMLButtonElement).disabled = true
        setTimeout(() => {
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

    const explainBtn = makeButton('Explain', '', () => startAnswer('micro-explain'))
    modeBtns.set('micro-explain', explainBtn)
    toolbar.appendChild(explainBtn)

    const askBtn = makeButton('Ask…', '', () => {
      asking = !asking
      renderAsk()
      syncToolbar()
      if (popover?.el === el) reposition()
    })
    modeBtns.set('custom', askBtn)
    toolbar.appendChild(askBtn)

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
      isolateKeys(input)
      row.append(input, go)
      toolbar.after(row)
      inputRow = row
      requestAnimationFrame(() => input.focus())
    }

    function startAnswer(mode: InlineMode, prompt?: string): void {
      stopAi()
      view = { mode, prompt }
      asking = false
      renderAsk()
      syncToolbar()
      expand()
      answerWrap?.remove()

      let text = ''
      let streaming = true
      let error = ''
      let copied = false

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
        const clone = range.cloneRange()
        window.getSelection()?.removeAllRanges()
        // Karakeep notes are plain text: keep the words, drop the markup.
        const note = markdownSegments(text)
          .map((seg) => seg.text)
          .join('')
          .trim()
        const hl = createHighlight(clone, lastUsedColor, { note })
        // Not the new highlight's popover: it would open with Delete under
        // the pointer that just clicked Save. Flash the highlight instead.
        closePopover()
        if (hl) {
          focusHighlight(hl.id)
          showToast('Highlight saved, with the answer as its note')
        }
      })
      saveAns.classList.add('kh-go')
      const spacer = document.createElement('div')
      spacer.className = 'kh-spacer'
      const stopBtn = makeButton('Stop', '', () => {
        stopAi()
        streaming = false
        paint()
      })
      foot.append(copyAns, spacer, stopBtn, saveAns)
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
        ;(saveAns as HTMLButtonElement).disabled = !ready
        stopBtn.style.display = streaming ? '' : 'none'
        if (popover?.el === el) reposition()
      }

      const port = chrome.runtime.connect({ name: AI_PORT })
      aiPort = port
      port.onMessage.addListener((m: AiPortOut) => {
        if (aiPort !== port) return
        if (m.type === 'chunk') {
          text += m.delta
        } else if (m.type === 'done') {
          text = m.fullText
          streaming = false
          stopAi()
        } else {
          error = m.error
          streaming = false
          stopAi()
        }
        paint()
      })
      port.onDisconnect.addListener(() => {
        if (aiPort !== port) return
        aiPort = null
        if (streaming) {
          streaming = false
          if (!text) error = 'The connection to the extension was lost.'
          paint()
        }
      })
      paint()

      const meta = getPageSourceMetadata()
      const request: AiStreamRequest = {
        requestId: `ai-ext-${Date.now()}`,
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
      }
      port.postMessage({ type: 'start', request })
    }

    mountPopover('selection', el, anchor)
  }

  // ───────────────────────── AI context extraction ─────────────────────────
  // Context comes from around the selection, not from the top of the
  // document — the first few thousand characters of most pages are nav
  // chrome and cookie banners.

  function nearestBlockContainer(node: Node): HTMLElement {
    let el: HTMLElement | null = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
    while (el && el !== document.body) {
      const display = getComputedStyle(el).display
      if (display && display !== 'inline' && display !== 'inline-block' && display !== 'contents') return el
      el = el.parentElement
    }
    return document.body || document.documentElement
  }

  function trimLeadingPartialSentence(s: string): string {
    const idx = s.search(/[.!?]\s+/)
    return idx >= 0 && idx < 150 ? s.slice(idx + 1).trimStart() : s
  }

  function trimTrailingPartialSentence(s: string): string {
    let cut = -1
    for (const c of ['. ', '! ', '? ', '.\n', '!\n', '?\n']) cut = Math.max(cut, s.lastIndexOf(c))
    return cut >= 0 && cut > s.length - 150 ? s.slice(0, cut + 1) : s
  }

  const SURROUNDING_WINDOW = 400

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

  function computePageTextAroundSelection(range: Range): string {
    const full = document.body?.innerText || ''
    if (!full) return ''
    try {
      const preRange = document.createRange()
      preRange.setStart(document.body, 0)
      preRange.setEnd(range.startContainer, range.startOffset)
      // Approximate: Range.toString() and innerText collapse whitespace
      // differently. Near the selection is the goal, not exactness.
      const approxOffset = preRange.toString().length
      const start = Math.max(0, approxOffset - PAGE_TEXT_HALF_WINDOW)
      return full.slice(start, Math.min(full.length, approxOffset + PAGE_TEXT_HALF_WINDOW))
    } catch {
      return full.slice(0, PAGE_TEXT_HALF_WINDOW * 2)
    }
  }

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
  function openHighlightPopover(hl: PageHighlight, opts: { note?: boolean } = {}): void {
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

    const accent = (): string => COLORS.find((c) => c.name === hl.color)?.hex || COLORS[0].hex

    const copyButton = (iconOnly: boolean): HTMLElement =>
      makeButton(
        iconOnly ? 'Copy highlighted text' : 'Copy',
        ICON_COPY,
        () => {
          void copyToClipboard(hl.text).catch(() => undefined)
          closePopover()
        },
        false,
        iconOnly
      )

    const deleteButton = (iconOnly: boolean): HTMLElement =>
      makeButton(
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

    const swatches = (): HTMLElement =>
      makeSwatchRow(hl.color, (color) => {
        setHighlightColor(hl, color)
        renderActions()
      })

    /** The default view; a note is shown right here, editing is one click away. */
    function renderActions(): void {
      el.textContent = ''
      if (hl.note) {
        el.className = 'kh-pop kh-read-mode'
        const note = document.createElement('div')
        note.className = 'kh-note-view'
        note.style.setProperty('--kh-accent', accent())
        note.textContent = hl.note
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
      isolateKeys(ta)
      el.appendChild(ta)

      const row = document.createElement('div')
      row.className = 'kh-row'
      const hint = document.createElement('span')
      hint.className = 'kh-hint'
      hint.textContent = /Mac/i.test(navigator.platform) ? '⌘↩ to save' : 'Ctrl+Enter to save'
      row.appendChild(hint)
      const spacer = document.createElement('div')
      spacer.className = 'kh-spacer'
      row.appendChild(spacer)

      const save = (): void => {
        setHighlightNote(hl, ta.value.trim())
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

  let unresolved: PageHighlight[] = []
  let anchorObserver: MutationObserver | null = null
  let retryHandle: ReturnType<typeof setTimeout> | null = null
  let observerDebounce: ReturnType<typeof setTimeout> | null = null
  let watchDeadline = 0

  function stopWatching(): void {
    anchorObserver?.disconnect()
    anchorObserver = null
    if (retryHandle) clearTimeout(retryHandle)
    retryHandle = null
    if (observerDebounce) clearTimeout(observerDebounce)
    observerDebounce = null
  }

  /**
   * Client-rendered pages often don't have the highlighted text in the DOM
   * yet when this script runs. Keep retrying as the DOM changes, then give
   * up rather than watching forever.
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
      if (unresolved.length) console.warn('[karakeep] could not place', unresolved.length, 'highlight(s) on this page')
      stopWatching()
      return
    }
    applyStored(unresolved)
  }

  function applyStored(list: PageHighlight[]): void {
    if (!list.length || !document.body) return
    anchorer.resetVisibilityCache()
    // Our own wrapping mutates the DOM; don't let that feed back into the
    // observer that triggered us.
    anchorObserver?.disconnect()

    const stillMissing: PageHighlight[] = []
    for (const h of list) {
      if (!h.text) continue
      if (marksFor(h.id).length) continue
      const found = anchorer.locateText(h.text, h.prefix, h.suffix, h.startOffset)
      const marks = found ? anchorer.wrapRange(found, h.id, h.color || DEFAULT_HIGHLIGHT_COLOR) : []
      if (!marks.length) {
        stillMissing.push(h)
        continue
      }
      const existing = pageHighlights.find((e) => e.id === h.id)
      const record = existing || h
      if (!existing) pageHighlights.push(record)
      marks.forEach((m) => bindMark(m, record))
      applyNoteAffordance(h.id, h.note || undefined)
    }

    unresolved = stillMissing
    if (anchorObserver && document.body) {
      anchorObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
    }
    if (unresolved.length) startWatching()
    else stopWatching()
  }

  function toPageHighlight(h: Highlight): PageHighlight {
    return {
      id: h.id,
      text: h.text || '',
      color: normalizeHighlightColor(h.color),
      note: h.note || '',
      startOffset: h.startOffset,
      endOffset: h.endOffset
    }
  }

  /**
   * Reconciles the server's list for this page with what's on it: anchors
   * anything new, drops marks for highlights deleted elsewhere, and picks up
   * colour and note edits.
   */
  function syncHighlights(list: Highlight[]): void {
    const incoming = list.map(toPageHighlight)
    const incomingIds = new Set(incoming.map((h) => h.id))
    for (const existing of [...pageHighlights]) {
      // Highlights created here are not on the server under their client id yet.
      if (existing.id.startsWith('kh-')) continue
      if (!incomingIds.has(existing.id)) removeLocal(existing.id)
    }
    for (const h of incoming) {
      const existing = pageHighlights.find((e) => e.id === h.id)
      if (!existing) continue
      if (h.color !== existing.color) {
        existing.color = h.color
        for (const m of marksFor(h.id)) m.dataset.khColor = h.color
      }
      if ((h.note || '') !== (existing.note || '')) {
        existing.note = h.note
        applyNoteAffordance(h.id, existing.note || undefined)
      }
    }
    ensureStyles()
    watchDeadline = Date.now() + 30000
    applyStored(incoming)
  }

  function clearAll(): void {
    closePopover()
    stopWatching()
    unresolved = []
    for (const h of [...pageHighlights]) removeLocal(h.id)
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

  // ───────────────────────── page lifecycle ─────────────────────────

  let initializedFor = ''

  async function initPage(): Promise<void> {
    const url = location.href
    initializedFor = url
    try {
      const init = await send<PageInit>({ type: 'page:init', url })
      if (initializedFor !== url) return
      if (init.configured && init.showHighlights && init.highlights.length) syncHighlights(init.highlights)
    } catch (err) {
      console.warn('[karakeep]', err instanceof Error ? err.message : err)
    }
  }

  // Single-page apps change the URL without a load. Each URL is its own
  // bookmark, so the previous page's highlights go and the new one's come in.
  function checkUrlChange(): void {
    if (location.href === initializedFor) return
    clearAll()
    void initPage()
  }
  window.addEventListener('popstate', checkUrlChange)
  setInterval(checkUrlChange, 1500)

  // ───────────────────────── events ─────────────────────────

  function currentSelectionRange(): Range | null {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
    if (!sel.toString().trim()) return null
    const range = sel.getRangeAt(0)
    let anchor: Node | null = sel.anchorNode
    if (anchor && anchor.nodeType !== Node.ELEMENT_NODE) anchor = anchor.parentElement
    if (anchor && (anchor as Element).closest?.('input, textarea, [contenteditable="true"], [contenteditable=""]')) return null
    return range
  }

  function openToolbarForSelection(): void {
    const range = currentSelectionRange()
    if (!range) {
      showToast('Select some text on the page first', false)
      return
    }
    openSelectionPopover(range)
  }

  // A selection toolbar belongs to the selection it was opened for. When that
  // selection goes away (a click elsewhere, a new drag), so does the toolbar —
  // unless it has grown an AI answer, which only a dismissal closes.
  document.addEventListener('selectionchange', () => {
    if (popover?.kind !== 'selection' || popover.sticky) return
    if (!currentSelectionRange()) closePopover()
  })

  document.addEventListener(
    'mousedown',
    (e) => {
      if (!popover) return
      const path = e.composedPath?.() || []
      if (overlay && path.includes(overlay.host)) return
      if ((e.target as Element)?.closest?.(`.${HIGHLIGHT_CLASS}`)) return
      // A right-click keeps the toolbar: the context menu is how it was
      // opened, and is how it would be reopened.
      if (e.button === 2) return
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

  chrome.runtime.onMessage.addListener((msg: TabMessage, _sender, sendResponse) => {
    switch (msg.type) {
      case 'kk:open-toolbar':
        openToolbarForSelection()
        break
      case 'kk:remove':
        if (popover?.highlightId === msg.id) closePopover()
        removeLocal(msg.id)
        break
      case 'kk:clear':
        clearAll()
        break
      case 'kk:focus':
        focusHighlight(msg.id)
        break
      case 'kk:toast':
        showToast(msg.text)
        break
    }
    sendResponse(true)
  })

  void initPage()
}

karakeepInit()
