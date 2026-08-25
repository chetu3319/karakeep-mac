/**
 * The one definition of what a highlight popover looks like.
 *
 * Two panes show this UI in two very different runtimes: the Web pane builds
 * it with raw DOM inside a closed shadow root in a preload script, and the PDF
 * pane builds it with React in the renderer. They used to be styled
 * independently, and drifted — same buttons, different radius, different
 * background, different swatch size. Everything visual therefore lives here,
 * as a plain stylesheet string plus class names both sides use, so parity is a
 * property of the code rather than something to remember.
 *
 * Only *appearance* and *placement* belong in this file. How a selection is
 * found, how a highlight is stored, and what the buttons do stay with the pane
 * that owns them.
 */

export interface HighlightColor {
  name: string
  hex: string
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { name: 'yellow', hex: '#f5c518' },
  { name: 'green', hex: '#10b981' },
  { name: 'blue', hex: '#3b82f6' },
  { name: 'purple', hex: '#a855f7' },
  { name: 'red', hex: '#ef4444' }
]

export const DEFAULT_HIGHLIGHT_COLOR = 'yellow'

export function hexForColor(color?: string | null): string {
  return HIGHLIGHT_COLORS.find((c) => c.name === color)?.hex ?? HIGHLIGHT_COLORS[0].hex
}

/** Lucide-ish single-path icons, drawn by both panes at 24x24. */
export const ICON_NOTE = 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'
export const ICON_COPY = 'M9 9h10v10H9zM5 15H4V4h11v1'
export const ICON_TRASH = 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14'
export const ICON_CHECK = 'M5 13l4 4L19 7'
export const ICON_AI = 'M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83'

/**
 * Styles for the popover.
 *
 * In the Web pane this is injected into a *closed shadow root* whose host
 * hangs off document.documentElement (not document.body), for two reasons
 * learned the hard way on real pages:
 *
 * 1. Nothing about the popover's visibility may depend on a CSS animation.
 *    A WebContentsView that isn't compositing (hidden window, occluded
 *    view) can leave a `forwards`-filled keyframe stuck at its 0% frame
 *    forever — producing an invisible but fully hit-testable overlay.
 * 2. The page's own cascade must not be able to reach in. A stray
 *    `transform`/`filter` on an ancestor, `overflow: hidden` on a wrapper,
 *    an id collision, or a global `* { opacity: 0 }` transition framework
 *    would otherwise clip or hide it. `body` is the element page frameworks
 *    most often transform, hence hanging the host off `<html>`.
 *
 * In the PDF pane it goes into the renderer document once and the popover is
 * portalled to a fixed full-viewport host. The `:host` rule simply doesn't
 * match there. Colours are written out literally rather than as Tailwind
 * classes so both runtimes get the same pixels — and because a Tailwind
 * opacity step that isn't in the scale (`bg-neutral-900/97`) silently compiles
 * to nothing, which is how the PDF popover ended up with no background at all.
 *
 * Positioning is `fixed` in viewport coordinates and clamped by
 * `placePopover()`, so a selection at any page edge still gets a fully
 * visible popover.
 */
export function highlightPopoverStylesheet(): string {
  const accent = HIGHLIGHT_COLORS[0].hex
  return `
    :host { all: initial; }
    .kh-pop {
      position: fixed;
      top: 0; left: 0;
      pointer-events: auto;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 5px;
      border-radius: 12px;
      background: rgba(32,32,35,0.94);
      box-shadow: 0 10px 30px rgba(0,0,0,0.32), 0 0 0 0.5px rgba(255,255,255,0.14);
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: #f2f2f7;
      /* Visible immediately — never gate visibility on an animation. */
      opacity: 1;
      max-width: calc(100vw - 20px);
    }
    @supports (backdrop-filter: blur(1px)) {
      .kh-pop { background: rgba(32,32,35,0.78); backdrop-filter: blur(24px) saturate(180%); }
    }
    .kh-pop * { box-sizing: border-box; }
    .kh-pop.kh-note-mode { flex-direction: column; align-items: stretch; gap: 8px; padding: 10px; width: 300px; }
    .kh-pop.kh-read-mode { flex-direction: column; align-items: stretch; gap: 9px; padding: 10px; width: 320px; }

    /* Reading a note is the common case, so it happens in place: the text
       scrolls inside the popover rather than taking over the page with a
       dialog. Capped height keeps the popover from swallowing the viewport
       on a long note; overscroll-behavior keeps its scroll from chaining
       into the page underneath. */
    .kh-note-view {
      max-height: 152px;
      overflow-y: auto;
      overscroll-behavior: contain;
      font-size: 13px; line-height: 1.5;
      white-space: pre-wrap; overflow-wrap: anywhere;
      color: rgba(242,242,247,0.94);
      border-left: 2px solid var(--kh-accent, ${accent});
      padding: 1px 2px 1px 9px;
      user-select: text; cursor: text;
    }
    .kh-note-view:focus-visible { outline: 2px solid rgba(255,255,255,0.5); outline-offset: 3px; border-radius: 2px; }
    .kh-note-view::-webkit-scrollbar { width: 9px; }
    .kh-note-view::-webkit-scrollbar-track { background: transparent; }
    .kh-note-view::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.24);
      border-radius: 5px;
      border: 2px solid transparent;
      background-clip: padding-box;
    }
    .kh-note-view::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.38); background-clip: padding-box; }
    .kh-toolbar { display: flex; align-items: center; gap: 2px; }
    .kh-toolbar .kh-spacer { flex: 1 1 auto; }
    .kh-btn.kh-icon-only { padding: 6px; }

    .kh-swatch {
      all: unset;
      box-sizing: border-box;
      width: 22px; height: 22px;
      border-radius: 50%;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex: 0 0 auto;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.18);
      transition: transform 0.1s ease;
    }
    .kh-swatch:hover { transform: scale(1.15); }
    .kh-swatch:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .kh-swatch[data-active="1"] { box-shadow: inset 0 0 0 1px rgba(0,0,0,0.18), 0 0 0 2px rgba(255,255,255,0.9); }
    .kh-swatch svg { width: 12px; height: 12px; display: block; }
    .kh-swatch[disabled] { cursor: default; opacity: 0.5; }

    .kh-sep { width: 1px; align-self: stretch; margin: 2px 4px; background: rgba(255,255,255,0.16); flex: 0 0 auto; }

    .kh-btn {
      all: unset;
      box-sizing: border-box;
      display: flex; align-items: center; gap: 5px;
      padding: 5px 9px;
      border-radius: 7px;
      cursor: pointer;
      white-space: nowrap;
      color: #f2f2f7;
      font: inherit;
      flex: 0 0 auto;
    }
    .kh-btn:hover { background: rgba(255,255,255,0.14); }
    .kh-btn:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
    .kh-btn[data-danger="1"]:hover { background: rgba(239,68,68,0.9); }
    .kh-btn[disabled] { cursor: default; opacity: 0.5; }
    .kh-btn[disabled]:hover { background: none; }
    .kh-btn svg { width: 14px; height: 14px; display: block; flex: 0 0 auto; }

    .kh-quote {
      font-size: 12px; line-height: 1.45; color: rgba(242,242,247,0.72);
      max-height: 52px; overflow: hidden;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
      border-left: 2px solid var(--kh-accent, ${accent});
      padding-left: 8px;
    }
    .kh-ta {
      all: unset;
      box-sizing: border-box;
      display: block;
      width: 100%;
      min-height: 76px;
      max-height: 40vh;
      padding: 8px 9px;
      border-radius: 8px;
      background: rgba(255,255,255,0.08);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14);
      color: #f2f2f7;
      font: inherit;
      resize: vertical;
      white-space: pre-wrap;
      overflow-y: auto;
    }
    .kh-ta:focus { box-shadow: inset 0 0 0 1px rgba(255,255,255,0.4); }
    .kh-ta::placeholder { color: rgba(242,242,247,0.4); }
    .kh-row { display: flex; align-items: center; gap: 6px; }
    .kh-row .kh-spacer { flex: 1 1 auto; }
    .kh-hint { font-size: 11px; color: rgba(242,242,247,0.45); }
    .kh-primary { background: #0a84ff; }
    .kh-primary:hover { background: #339cff; }
  `
}

/**
 * Places the popover in viewport coordinates: above the anchor by default,
 * flipped below when there isn't room, and always clamped horizontally so a
 * selection at the left or right edge still gets a fully visible popover.
 */
export function placePopover(el: HTMLElement, rect: DOMRect): void {
  const margin = 10
  const gap = 8
  const vw = document.documentElement.clientWidth || window.innerWidth
  const vh = document.documentElement.clientHeight || window.innerHeight
  const { width, height } = el.getBoundingClientRect()

  let top = rect.top - height - gap
  if (top < margin) top = rect.bottom + gap
  if (top + height > vh - margin) top = Math.max(margin, vh - margin - height)

  let left = rect.left + rect.width / 2 - width / 2
  left = Math.max(margin, Math.min(left, vw - width - margin))

  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`
}
