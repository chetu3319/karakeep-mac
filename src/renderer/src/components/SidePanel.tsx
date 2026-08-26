import React from 'react'
import Icon from './Icon'

/**
 * The shell both docked side panes sit in.
 *
 * There are two of them — the highlight rail and the AI Co-Pilot — and
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
  return (
    <aside className="flex h-full w-80 flex-shrink-0 flex-col border-l border-neutral-200 bg-neutral-50/60 dark:border-neutral-800 dark:bg-neutral-900/40">
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
