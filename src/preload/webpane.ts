/**
 * Preload script for the live "Web" pane WebContentsView.
 *
 * Adapted from reference/karakeep-extension-content.js (Karakeep browser
 * extension's highlight content script) and
 * reference/karakeep-extension-content-styles.js. The selection-to-highlight
 * capture, text-offset scheme, and fuzzy re-anchoring logic are reused
 * near-verbatim; only the transport (chrome.runtime messaging -> Electron
 * ipcRenderer) and bootstrapping differ.
 */
import { ipcRenderer } from 'electron'

const HIGHLIGHT_CLASS = 'karakeep-hl'
const TOOLBAR_ID = 'karakeep-toolbar'
const NOTE_HOST_ID = 'karakeep-note-host'
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

function getStylesheet(): string {
  return `
    .${HIGHLIGHT_CLASS} {
      background: rgba(16,185,129,0.3) !important;
      border-bottom: 2px solid rgba(16,185,129,0.6);
      cursor: pointer;
      transition: background 0.15s;
    }
    .${HIGHLIGHT_CLASS}:hover { background: rgba(16,185,129,0.5) !important; }
    .${HIGHLIGHT_CLASS}[data-kh-color="yellow"] { background: rgba(250,204,21,0.3) !important; border-bottom-color: rgba(250,204,21,0.6); }
    .${HIGHLIGHT_CLASS}[data-kh-color="yellow"]:hover { background: rgba(250,204,21,0.5) !important; }
    .${HIGHLIGHT_CLASS}[data-kh-color="red"] { background: rgba(239,68,68,0.25) !important; border-bottom-color: rgba(239,68,68,0.5); }
    .${HIGHLIGHT_CLASS}[data-kh-color="red"]:hover { background: rgba(239,68,68,0.4) !important; }
    .${HIGHLIGHT_CLASS}[data-kh-color="blue"] { background: rgba(59,130,246,0.25) !important; border-bottom-color: rgba(59,130,246,0.5); }
    .${HIGHLIGHT_CLASS}[data-kh-color="blue"]:hover { background: rgba(59,130,246,0.4) !important; }
    .${HIGHLIGHT_CLASS}[data-kh-color="purple"] { background: rgba(168,85,247,0.25) !important; border-bottom-color: rgba(168,85,247,0.5); }
    .${HIGHLIGHT_CLASS}[data-kh-color="purple"]:hover { background: rgba(168,85,247,0.4) !important; }
    .${HIGHLIGHT_CLASS}[data-kh-note="1"] {
      cursor: help;
    }
    .${HIGHLIGHT_CLASS}[data-kh-note="1"]::after {
      content: '\\1F4DD'; font-size: 10px; vertical-align: super; margin-left: 2px;
    }
    #${TOOLBAR_ID} {
      /* Visible immediately — do not gate the toolbar's visibility on a CSS
         animation. A backgrounded/occluded WebContentsView can leave a
         forwards-filled keyframe animation stuck at its 0% frame (opacity:
         0) indefinitely, producing an invisible-but-interactive toolbar.
         See the note dialog fix below for the empirical repro. */
      position: absolute; z-index: 2147483647; display: flex; gap: 4px; padding: 6px 8px;
      background: #1f2937; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      font-family: system-ui, -apple-system, sans-serif; opacity: 1;
    }
    #${TOOLBAR_ID} button {
      border: none; background: transparent; color: #e5e7eb; cursor: pointer; padding: 4px 8px;
      border-radius: 4px; font-size: 13px; font-family: inherit; display: flex; align-items: center;
      gap: 4px; white-space: nowrap; transition: background 0.1s;
    }
    #${TOOLBAR_ID} button:hover { background: rgba(255,255,255,0.15); }
    #${TOOLBAR_ID} .kh-dot { width: 16px; height: 16px; border-radius: 50%; padding: 0; border: 2px solid transparent; flex-shrink: 0; }
    #${TOOLBAR_ID} .kh-dot:hover { border-color: #fff; }
    #${TOOLBAR_ID} .kh-sep { width: 1px; background: rgba(255,255,255,0.2); margin: 0 2px; }
  `
}

/**
 * Styles for the note overlay + dialog. Injected inside a *closed shadow
 * root*, not document.head, and the host element lives outside document.body
 * (see openNote()). Two independent problems this fixes, confirmed via a
 * standalone Electron repro against the live arxiv bookmark page:
 *
 * 1. The dialog previously depended on a `forwards`-filled CSS keyframe
 *    animation (`kh-dialog-in`) to ever reach opacity: 1. When the
 *    WebContentsView's compositor doesn't pump a frame right after the
 *    dialog is inserted (observed: a WebContentsView added to a hidden/
 *    unfocused BrowserWindow never advances the animation at all), the
 *    dialog is permanently stuck at its 0% keyframe — opacity: 0, fully
 *    rendered, fully hit-testable. That exactly matches the reported
 *    symptom: overlay visibly darkens the page, dialog is present and
 *    blocking clicks, but nothing is visible or usable. Fix: the dialog is
 *    opacity: 1 by default; no animation gates its visibility.
 * 2. The dialog and overlay were appended to the live page's own
 *    document.body/document.head, sharing the page's global CSS cascade.
 *    A hostile or merely coincidental page rule (transform/filter on an
 *    ancestor, an ID collision, `mark { all: unset }`, a global
 *    `* { opacity: 0 }` transition-in framework, etc.) can break this in
 *    ways we can't audit for up front. A closed shadow root, hung off a
 *    host element appended to document.documentElement (not body — body is
 *    the ancestor most commonly given a transform by page frameworks),
 *    isolates our styles from the page's cascade in both directions.
 */
function getDialogStylesheet(): string {
  return `
    :host { all: initial; }
    .kh-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.3); }
    .kh-dialog {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
      background: #fff; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.3); padding: 0; border: none;
      width: 400px; max-width: 90vw; font-family: system-ui, -apple-system, sans-serif;
      /* Visible immediately — see the file-level comment above. */
      opacity: 1;
    }
    .kh-hdr { padding: 12px 16px; border-bottom: 1px solid #e5e7eb; font-weight: 600; font-size: 14px; color: #111827; display: flex; justify-content: space-between; align-items: center; }
    .kh-body { padding: 12px 16px; }
    .kh-quote { background: #f3f4f6; border-left: 3px solid #10b981; padding: 8px 12px; margin-bottom: 12px; border-radius: 0 6px 6px 0; font-size: 13px; color: #374151; max-height: 80px; overflow-y: auto; white-space: pre-wrap; }
    .kh-ta { width: 100%; min-height: 80px; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; font-family: inherit; resize: vertical; outline: none; box-sizing: border-box; color: #111827; background: #fff; }
    .kh-ta:focus { border-color: #10b981; box-shadow: 0 0 0 2px rgba(16,185,129,0.15); }
    .kh-ftr { padding: 8px 16px 12px; display: flex; justify-content: flex-end; gap: 8px; }
    .kh-ftr button { padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; font-family: inherit; border: none; }
    .kh-cancel { background: #f3f4f6; color: #374151; }
    .kh-cancel:hover { background: #e5e7eb; }
    .kh-del { background: #f3f4f6; color: #ef4444; }
    .kh-del:hover { background: #fef2f2; }
    .kh-save-btn { background: #10b981; color: #fff; }
    .kh-save-btn:hover { background: #059669; }
    .kh-close { background: none; border: none; cursor: pointer; font-size: 18px; color: #9ca3af; padding: 0; line-height: 1; }
    .kh-close:hover { color: #374151; }
    @media (prefers-color-scheme: dark) {
      .kh-dialog { background: #1f2937; }
      .kh-hdr { color: #f9fafb; border-bottom-color: #374151; }
      .kh-quote { background: #111827; color: #d1d5db; }
      .kh-ta { background: #111827; border-color: #4b5563; color: #f9fafb; }
      .kh-cancel { background: #374151; color: #d1d5db; }
      .kh-cancel:hover { background: #4b5563; }
    }
  `
}

function karakeepInit(): void {
  const w = window as unknown as { __karakeepHL?: boolean }
  if (w.__karakeepHL) return
  w.__karakeepHL = true

  let pageHighlights: StoredHighlight[] = []

  function ensureStyles(): void {
    if (document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = getStylesheet()
    document.head.appendChild(el)
  }

  function uid(): string {
    return 'kh-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  }

  function textNodesIn(range: Range): Node[] {
    const start = range.startContainer
    const end = range.endContainer
    if (start === end && start.nodeType === Node.TEXT_NODE) return [start]
    const result: Node[] = []
    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT)
    let n: Node | null
    while ((n = walker.nextNode())) {
      if (range.intersectsNode(n)) result.push(n)
    }
    return result
  }

  function wrapRange(range: Range, id: string, color: string): HTMLElement[] {
    const nodes = textNodesIn(range)
    const marks: HTMLElement[] = []
    for (const node of nodes) {
      const nr = document.createRange()
      nr.selectNodeContents(node)
      if (node === range.startContainer) nr.setStart(node, range.startOffset)
      if (node === range.endContainer) nr.setEnd(node, range.endOffset)
      if (nr.collapsed || !nr.toString().trim()) continue
      try {
        const mark = document.createElement('mark')
        mark.className = HIGHLIGHT_CLASS
        mark.dataset.khId = id
        mark.dataset.khColor = color
        nr.surroundContents(mark)
        marks.push(mark)
      } catch {
        // surroundContents can throw if the range partially selects a non-Text node
      }
    }
    return marks
  }

  function textOffsetOf(node: Node, nodeOffset: number): number {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let total = 0
    let n: Node | null
    while ((n = tw.nextNode())) {
      if (n === node) return total + nodeOffset
      total += (n.textContent || '').length
    }
    return -1
  }

  const CONTEXT_LEN = 50

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

  function sendHost(channel: string, payload: unknown): void {
    ipcRenderer.send(channel, payload)
  }

  function createHighlight(sel: Selection, color: string, withNote: boolean): void {
    if (!sel || sel.isCollapsed) return
    const text = sel.toString().trim()
    if (!text) return

    const range = sel.getRangeAt(0)
    const id = uid()
    const context = extractContext(range)
    const startOffset = textOffsetOf(range.startContainer, range.startOffset)
    const endOffset = textOffsetOf(range.endContainer, range.endOffset)
    const marks = wrapRange(range, id, color)
    if (!marks.length) return

    sel.removeAllRanges()

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

    marks.forEach((m) => m.addEventListener('click', () => openNote(hl)))

    sendHost('kk:highlight-created', hl)

    if (withNote) openNote(hl)
  }

  function destroyHighlight(id: string): void {
    document.querySelectorAll(`[data-kh-id="${id}"]`).forEach((m) => {
      const p = m.parentNode
      if (!p) return
      while (m.firstChild) p.insertBefore(m.firstChild, m)
      p.removeChild(m)
      p.normalize()
    })
    pageHighlights = pageHighlights.filter((h) => h.id !== id)
    sendHost('kk:highlight-removed', { id })
  }

  function showToolbar(sel: Selection): void {
    hideToolbar()
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const bar = document.createElement('div')
    bar.id = TOOLBAR_ID

    function addBtn(label: string, fn: () => void): void {
      const b = document.createElement('button')
      b.textContent = label
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        fn()
        hideToolbar()
      })
      bar.appendChild(b)
    }

    addBtn('✨ Highlight', () => createHighlight(sel, 'green', false))
    addBtn('📝 Note', () => createHighlight(sel, 'green', true))

    const sep = document.createElement('div')
    sep.className = 'kh-sep'
    bar.appendChild(sep)

    const palette: [string, string][] = [
      ['green', '#10b981'],
      ['yellow', '#facc15'],
      ['red', '#ef4444'],
      ['blue', '#3b82f6'],
      ['purple', '#a855f7']
    ]
    palette.forEach(([name, hex]) => {
      const dot = document.createElement('button')
      dot.className = 'kh-dot'
      dot.style.backgroundColor = hex
      dot.title = name
      dot.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      dot.addEventListener('click', (e) => {
        e.stopPropagation()
        createHighlight(sel, name, false)
        hideToolbar()
      })
      bar.appendChild(dot)
    })

    bar.style.top = rect.top + window.scrollY - 44 + 'px'
    bar.style.left = rect.left + window.scrollX + rect.width / 2 + 'px'
    bar.style.transform = 'translateX(-50%)'
    document.body.appendChild(bar)
  }

  function hideToolbar(): void {
    document.getElementById(TOOLBAR_ID)?.remove()
  }

  let noteHost: HTMLElement | null = null

  /** Sets the note dataset/tooltip on every mark for a given highlight id
   * so the note is genuinely visible on the live page — a hover tooltip
   * with the actual text, not just the pencil-emoji marker — without
   * requiring the (previously broken) dialog to work at all. */
  function applyNoteAffordance(id: string, note: string | undefined): void {
    document.querySelectorAll(`[data-kh-id="${id}"]`).forEach((m) => {
      const el = m as HTMLElement
      el.dataset.khNote = note ? '1' : ''
      if (note) el.title = note
      else el.removeAttribute('title')
    })
  }

  function openNote(hl: StoredHighlight): void {
    closeNote()

    // Host lives outside document.body (on <html> itself) with a closed
    // shadow root, so the page's own stylesheets can't reach in and the
    // page's own script can't reach the dialog's DOM. See the file-level
    // comment on getDialogStylesheet() for why.
    const host = document.createElement('div')
    host.id = NOTE_HOST_ID
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;'
    document.documentElement.appendChild(host)
    noteHost = host
    const root = host.attachShadow({ mode: 'closed' })

    const styleEl = document.createElement('style')
    styleEl.textContent = getDialogStylesheet()
    root.appendChild(styleEl)

    const ov = document.createElement('div')
    ov.className = 'kh-overlay'
    ov.addEventListener('click', closeNote)
    root.appendChild(ov)

    const dlg = document.createElement('div')
    dlg.className = 'kh-dialog'

    const hdr = document.createElement('div')
    hdr.className = 'kh-hdr'
    const hdrTitle = document.createElement('span')
    hdrTitle.textContent = hl.note ? 'Edit Note' : 'Add Note'
    const closeBtn = document.createElement('button')
    closeBtn.className = 'kh-close'
    closeBtn.innerHTML = '&times;'
    closeBtn.addEventListener('click', closeNote)
    hdr.appendChild(hdrTitle)
    hdr.appendChild(closeBtn)
    dlg.appendChild(hdr)

    const body = document.createElement('div')
    body.className = 'kh-body'

    const quote = document.createElement('div')
    quote.className = 'kh-quote'
    quote.textContent = hl.text
    body.appendChild(quote)

    const ta = document.createElement('textarea')
    ta.className = 'kh-ta'
    ta.placeholder = 'Add your note here…'
    ta.value = hl.note || ''
    body.appendChild(ta)
    dlg.appendChild(body)

    const ftr = document.createElement('div')
    ftr.className = 'kh-ftr'

    const delBtn = document.createElement('button')
    delBtn.className = 'kh-del'
    delBtn.textContent = 'Delete'
    delBtn.addEventListener('click', () => {
      destroyHighlight(hl.id)
      closeNote()
    })
    ftr.appendChild(delBtn)

    const spacer = document.createElement('div')
    spacer.style.flex = '1'
    ftr.appendChild(spacer)

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'kh-cancel'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', closeNote)
    ftr.appendChild(cancelBtn)

    const saveBtn = document.createElement('button')
    saveBtn.className = 'kh-save-btn'
    saveBtn.textContent = 'Save Note'
    saveBtn.addEventListener('click', () => {
      hl.note = ta.value.trim()
      applyNoteAffordance(hl.id, hl.note)
      sendHost('kk:highlight-updated', hl)
      closeNote()
    })
    ftr.appendChild(saveBtn)
    dlg.appendChild(ftr)

    root.appendChild(dlg)
    ta.focus()

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        saveBtn.click()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeNote()
      }
    })
  }

  function closeNote(): void {
    noteHost?.remove()
    noteHost = null
  }

  function normalizeForMatch(str: string): string {
    return str
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[–—−]/g, '-')
      .replace(/[ \t\n\r\f\v]/g, ' ')
  }

  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function buildFuzzyPattern(needle: string): RegExp | null {
    const parts = needle.split(/\s+/).filter(Boolean).map(escapeRegExp)
    if (!parts.length) return null
    try {
      return new RegExp(parts.join('\\s+'), 'g')
    } catch {
      return null
    }
  }

  function findOccurrences(full: string, needle: string): { start: number; end: number }[] {
    const occurrences: { start: number; end: number }[] = []
    let searchFrom = 0
    while (true) {
      const idx = full.indexOf(needle, searchFrom)
      if (idx < 0) break
      occurrences.push({ start: idx, end: idx + needle.length })
      searchFrom = idx + 1
    }
    if (occurrences.length) return occurrences

    const pattern = buildFuzzyPattern(needle)
    if (!pattern) return occurrences
    let m: RegExpExecArray | null
    while ((m = pattern.exec(full))) {
      occurrences.push({ start: m.index, end: m.index + m[0].length })
      if (m[0].length === 0) pattern.lastIndex++
    }
    return occurrences
  }

  function locateText(needle: string, prefix?: string, suffix?: string): Range | null {
    if (!needle) return null
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const nodes: Node[] = []
    let n: Node | null
    while ((n = tw.nextNode())) nodes.push(n)

    let full = ''
    const map: { node: Node; start: number; end: number }[] = []
    nodes.forEach((tn) => {
      const s = full.length
      full += tn.textContent || ''
      map.push({ node: tn, start: s, end: full.length })
    })

    const normFull = normalizeForMatch(full)
    const normNeedle = normalizeForMatch(needle)
    const occurrences = findOccurrences(normFull, normNeedle)
    if (occurrences.length === 0) {
      console.warn('[karakeep] could not locate highlight text on live DOM', needle.slice(0, 40))
      return null
    }

    let best = occurrences[0]
    if (occurrences.length > 1 && (prefix || suffix)) {
      let bestScore = -1
      for (const occ of occurrences) {
        let score = 0
        if (prefix) {
          const actualPrefix = full.slice(Math.max(0, occ.start - prefix.length), occ.start)
          const pLen = Math.min(actualPrefix.length, prefix.length)
          for (let pi = 0; pi < pLen; pi++) {
            if (actualPrefix[actualPrefix.length - 1 - pi] === prefix[prefix.length - 1 - pi]) score++
            else break
          }
        }
        if (suffix) {
          const actualSuffix = full.slice(occ.end, occ.end + suffix.length)
          const sLen = Math.min(actualSuffix.length, suffix.length)
          for (let si = 0; si < sLen; si++) {
            if (actualSuffix[si] === suffix[si]) score++
            else break
          }
        }
        if (score > bestScore) {
          bestScore = score
          best = occ
        }
      }
    }

    let sNode: Node | null = null
    let sOff = 0
    let eNode: Node | null = null
    let eOff = 0
    for (const entry of map) {
      if (!sNode && entry.end > best.start) {
        sNode = entry.node
        sOff = best.start - entry.start
      }
      if (entry.end >= best.end) {
        eNode = entry.node
        eOff = best.end - entry.start
        break
      }
    }
    if (!sNode || !eNode) return null
    const r = document.createRange()
    r.setStart(sNode, sOff)
    r.setEnd(eNode, eOff)
    return r
  }

  function applyStored(list: StoredHighlight[]): void {
    if (!list || !list.length) return
    list.forEach((h) => {
      if (pageHighlights.some((e) => e.id === h.id)) return
      const found = locateText(h.text, h.prefix, h.suffix)
      if (!found) return
      const marks = wrapRange(found, h.id, h.color || 'green')
      if (!marks.length) return
      marks.forEach((m) => {
        m.addEventListener('click', () => openNote(h))
      })
      applyNoteAffordance(h.id, h.note || undefined)
      pageHighlights.push(h)
    })
  }

  let timer: ReturnType<typeof setTimeout> | null = null

  document.addEventListener('mouseup', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const s = window.getSelection()
      if (s && !s.isCollapsed && s.toString().trim()) {
        let anchor: Node | null = s.anchorNode
        if (anchor && anchor.nodeType !== Node.ELEMENT_NODE) anchor = anchor.parentElement
        // The note dialog now lives in a closed shadow root outside
        // document.body, so a selection made inside it can't be reached via
        // a light-DOM closest() lookup in the first place — only the
        // toolbar (still light-DOM) needs guarding here.
        if (anchor && (anchor as Element).closest?.(`#${TOOLBAR_ID}`)) return
        showToolbar(s)
      } else {
        hideToolbar()
      }
    }, 200)
  })

  document.addEventListener('mousedown', (e) => {
    const tb = document.getElementById(TOOLBAR_ID)
    if (tb && !tb.contains(e.target as Node)) hideToolbar()
  })

  ipcRenderer.on('kk:apply', (_e, highlights: StoredHighlight[]) => {
    applyStored(highlights)
  })

  document.addEventListener('DOMContentLoaded', () => ensureStyles())
  ensureStyles()
  ipcRenderer.send('kk:ready')
}

karakeepInit()
