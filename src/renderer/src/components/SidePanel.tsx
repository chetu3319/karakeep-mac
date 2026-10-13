import React, { useCallback, useEffect, useRef } from 'react'
import Icon from './Icon'
import { usePref } from '../lib/prefs'

const DEFAULT_WIDTH = 320
const MIN_WIDTH = 260
const NUDGE = 16
const NUDGE_LARGE = 64

/** Widest the panel is allowed to get: generous, but never so wide the
 * reading pane it's carved out of stops being usable. Recomputed against
 * the live window width rather than a fixed constant so it still makes
 * sense after the window is resized. */
function maxWidth(): number {
  return Math.min(720, window.innerWidth * 0.6)
}

function clampWidth(width: number): number {
  return Math.min(Math.max(width, MIN_WIDTH), Math.max(MIN_WIDTH, maxWidth()))
}

/**
 * The shell both docked side panes sit in.
 *
 * There are two of them — the highlight rail and the Study panel — and
 * they had drifted into two different designs: 288px against 320px, a
 * tinted panel against a white one, an uppercase label against a
 * sentence-case heading with a status dot, and two different close
 * buttons (a shared Icon in one, a hand-rolled inline `<svg>` in the
 * other). Since only one can be open at a time, switching between them
 * re-drew the entire right-hand edge of the window.
 *
 * Everything above the content is fixed here so neither pane can drift
 * again: same width, same surface, same header rhythm, same close
 * affordance. A pane contributes a title, an optional scope line, its own
 * header actions, and its body.
 *
 * Width is user-resizable by dragging the left edge, and shared between
 * both panes under one `usePref` key — since only one is ever open, a
 * single stored width means switching panes never jumps the reading pane
 * around. The stored width is read synchronously on first render (see
 * lib/prefs.ts), so there's no flash at the default before it snaps to
 * whatever the user last left it at.
 */
export default function SidePanel({
  title,
  count,
  subtitle,
  actions,
  onClose,
  closeLabel,
  children
}: {
  title: string
  /** Shown next to the title when the pane counts something. */
  count?: number
  /** One quiet line under the title — what this pane is scoped to. */
  subtitle?: string
  /** Pane-specific header controls, left of the close button. */
  actions?: React.ReactNode
  onClose: () => void
  closeLabel: string
  children: React.ReactNode
}): React.JSX.Element {
  const [width, setWidth] = usePref('sidePanelWidth', DEFAULT_WIDTH)

  // A width persisted from a previous, wider window (or before a display
  // change) could be wider than what's on screen now. Re-clamp whenever
  // the window resizes so the panel can never be left wider than the
  // window, and clamp once up front for the same reason.
  useEffect(() => {
    setWidth((w) => clampWidth(w))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function onResize(): void {
      setWidth((w) => clampWidth(w))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setWidth])

  const dragState = useRef<{ startX: number; startWidth: number } | null>(null)

  const beginDrag = useCallback(
    (clientX: number) => {
      dragState.current = { startX: clientX, startWidth: width }
      // The drag reads mouse position against document width repeatedly;
      // without suppressing selection, every move re-selects whatever text
      // the cursor crosses over in the reading pane, and the cursor itself
      // flickers back to the platform default between handle and content.
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    },
    [width]
  )

  const endDrag = useCallback(() => {
    dragState.current = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }, [])

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      beginDrag(e.clientX)
    },
    [beginDrag]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragState.current
      if (!drag) return
      // The panel is docked to the right edge, so dragging the handle left
      // (negative delta) widens it — invert the raw pointer delta.
      const delta = drag.startX - e.clientX
      setWidth(clampWidth(drag.startWidth + delta))
    },
    [setWidth]
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragState.current) endDrag()
      if ((e.target as HTMLElement).hasPointerCapture?.(e.pointerId)) {
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      }
    },
    [endDrag]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? NUDGE_LARGE : NUDGE
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setWidth((w) => clampWidth(w + step))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setWidth((w) => clampWidth(w - step))
      } else if (e.key === 'Home') {
        e.preventDefault()
        setWidth(MIN_WIDTH)
      } else if (e.key === 'End') {
        e.preventDefault()
        setWidth(clampWidth(maxWidth()))
      }
    },
    [setWidth]
  )

  const resetWidth = useCallback(() => {
    setWidth(DEFAULT_WIDTH)
  }, [setWidth])

  return (
    <aside
      className="relative flex h-full flex-shrink-0 flex-col border-l border-neutral-200 bg-neutral-50/60 dark:border-neutral-800 dark:bg-neutral-900/40"
      style={{ width }}
    >
      {/* Drag handle, overlaid on the left edge rather than taking up its
          own flex column — a 5px strip is too thin to be a layout box in
          its own right, and a wider invisible hit area is what makes it
          actually grabbable. Positioned absolutely so it doesn't perturb
          the border it sits on.

          The hit area sits *entirely inside* the panel rather than
          straddling its edge. On the web tab the reading pane is a native
          WebContentsView layered over the renderer, so any pixel left of
          this panel's edge is hit-tested by the loaded page, not by us —
          a handle that overhung the border would have a dead outer half
          on exactly the surface people resize from most. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={Math.round(width)}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={Math.round(maxWidth())}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        onDoubleClick={resetWidth}
        className="group absolute left-0 top-0 z-10 h-full w-2.5 cursor-col-resize touch-none focus:outline-none"
      >
        <div className="h-full w-[3px] bg-transparent transition-colors group-hover:bg-neutral-300 group-active:bg-emerald-500/70 group-focus-visible:bg-emerald-500/70 dark:group-hover:bg-neutral-700 dark:group-active:bg-emerald-500/70 dark:group-focus-visible:bg-emerald-500/70" />
      </div>
      <div className="flex items-start gap-1.5 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            {title}
            {count !== undefined && <span className="ml-1.5 tabular-nums text-neutral-500">{count}</span>}
          </h2>
          {subtitle && (
            <p className="mt-0.5 truncate text-[11px] normal-case tracking-normal text-neutral-500">{subtitle}</p>
          )}
        </div>
        {actions}
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
          className="grid h-6 w-6 flex-shrink-0 place-items-center rounded text-neutral-400 hover:bg-neutral-200/70 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <Icon name="close" size={13} />
        </button>
      </div>
      {children}
    </aside>
  )
}
