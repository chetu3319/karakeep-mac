import React from 'react'

/**
 * Empty, draggable strip that holds the macOS traffic lights.
 *
 * With `titleBarStyle: 'hiddenInset'` the OS draws the three window buttons
 * over whichever pane is leftmost, at a fixed point (see trafficLightPosition
 * in main/index.ts), so that pane has to reserve the space and stay
 * draggable. The Sidebar renders this when it is showing; App puts it atop
 * the bookmark-list column when only the sidebar is hidden.
 *
 * It used to carry the sidebar and bookmark-list toggles, pinned to fixed
 * coordinates so a hidden pane never moved the button that brought it back.
 * Two always-visible pane buttons were confusing, so layout is now one
 * control in the reader's own bar (DetailPane) that toggles Focus Mode. When
 * both panes are collapsed the reader is leftmost and its bar reserves the
 * traffic-light inset itself, using TRAFFIC_LIGHT_INSET below.
 */

export const TITLEBAR_H = 52
/** Left inset that clears the three traffic lights plus a margin. */
export const TRAFFIC_LIGHT_INSET = 86

export default function TitlebarRow(): React.JSX.Element {
  return <div className="titlebar-drag flex-shrink-0" style={{ height: TITLEBAR_H }} />
}
