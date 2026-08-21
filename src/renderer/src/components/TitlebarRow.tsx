import React from 'react'
import Icon from './Icon'

/**
 * The window's title area, and the only home for the pane toggles.
 *
 * Two things make this component worth existing rather than being inlined
 * at its two call sites.
 *
 * **The toggles must not move.** They used to be placed on the panes
 * themselves — collapse on the pane it collapsed, expand wherever the
 * pane had gone — so a control could sit at the right edge of a 230px
 * sidebar in one state and at x=86 in the next. Hiding a pane relocated
 * the button you would use to bring it back, which meant re-finding it
 * every time instead of clicking the same pixel twice. Both toggles now
 * live here, at the window's top-left, and this row renders at exactly the
 * same coordinates in every combination of collapsed panes. Clicking a
 * toggle twice returns you to where you started without the pointer
 * moving.
 *
 * **Each pane keeps one icon in both directions.** A sidebar that
 * collapsed with `‹` and expanded with a panel glyph was two controls as
 * far as recognition is concerned. The side-panel icon means "the
 * sidebar", and `‹` means "the bookmark list", regardless of which way the
 * click will go — state is carried by the tooltip and by dimming, neither
 * of which shifts anything.
 *
 * Rendered by whichever pane is currently leftmost, because with
 * `titleBarStyle: 'hiddenInset'` macOS draws its traffic lights over that
 * pane at a fixed point (see trafficLightPosition in main/index.ts) and
 * something has to hold that space and stay draggable. The Sidebar renders
 * it when it is showing; App puts it at the top of the bookmark-list
 * column, or the detail column, when it is not.
 */

export const TITLEBAR_H = 52
/** Left inset that clears the three traffic lights plus a margin. */
export const TRAFFIC_LIGHT_INSET = 86

export default function TitlebarRow({
  sidebarCollapsed,
  listCollapsed,
  onToggleSidebar,
  onToggleList
}: {
  sidebarCollapsed: boolean
  listCollapsed: boolean
  onToggleSidebar: () => void
  onToggleList: () => void
}): React.JSX.Element {
  return (
    <div
      className="titlebar-drag flex flex-shrink-0 items-center gap-1 pr-2"
      style={{ height: TITLEBAR_H, paddingLeft: TRAFFIC_LIGHT_INSET }}
    >
      <PaneToggle
        icon="sidebar"
        collapsed={sidebarCollapsed}
        label="sidebar"
        shortcut="⌃⌘S"
        onToggle={onToggleSidebar}
      />
      <PaneToggle
        icon="chevron-left"
        collapsed={listCollapsed}
        label="bookmark list"
        shortcut="⌃⌘L"
        onToggle={onToggleList}
      />
    </div>
  )
}

function PaneToggle({
  icon,
  collapsed,
  label,
  shortcut,
  onToggle
}: {
  icon: 'sidebar' | 'chevron-left'
  collapsed: boolean
  label: string
  shortcut: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      // `aria-pressed` describes the toggle's state, and "pressed" reads
      // most naturally as "this pane is showing" — the button looks
      // engaged while the thing it controls is out.
      aria-pressed={!collapsed}
      aria-label={`${collapsed ? 'Show' : 'Hide'} ${label}`}
      title={`${collapsed ? 'Show' : 'Hide'} ${label} (${shortcut})`}
      className={`titlebar-no-drag grid h-7 w-7 place-items-center rounded-md transition-colors ${
        collapsed
          ? 'text-neutral-400 hover:bg-neutral-200/70 hover:text-neutral-700 dark:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
          : 'text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-800'
      }`}
    >
      <Icon name={icon} />
    </button>
  )
}
