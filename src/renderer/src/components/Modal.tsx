import React, { useEffect, useRef, useState } from 'react'

/**
 * The shell every dialog in the app sits in.
 *
 * Each dialog used to roll its own overlay, and all of them stopped at
 * "click the backdrop to close". Escape did nothing, Tab walked straight
 * out of the dialog into the library behind it, and closing left focus on
 * `document.body` — so the next Tab started from the top of the window
 * rather than from whatever opened the dialog.
 *
 * Three things happen here that are tedious to repeat and easy to forget:
 *
 * - **Escape closes.** Registered on the dialog element rather than the
 *   window, so an Escape meant for an inner control (cancelling an inline
 *   edit, closing a native `<select>` popup) can be swallowed by that
 *   control first and never reach us.
 * - **Focus is contained.** Tab and Shift+Tab wrap around the dialog's own
 *   focusable elements instead of escaping into the page behind the
 *   backdrop.
 * - **Focus is restored.** Whatever was focused when the dialog opened gets
 *   it back on close, so keyboard users land where they started.
 *
 * Deliberately no dependency: there is no focus-trap library installed and
 * a dialog is not worth adding one for.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function Modal({
  onClose,
  labelledBy,
  role = 'dialog',
  className = '',
  children
}: {
  onClose: () => void
  labelledBy: string
  role?: 'dialog' | 'alertdialog'
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  // Captured during the first *render*, not in the effect below. By the
  // time effects run, React has already honoured any `autoFocus` in the
  // dialog's own markup, so document.activeElement is a field inside this
  // dialog rather than the control that opened it — and restoring focus
  // to that on close would be a no-op.
  const [opener] = useState<HTMLElement | null>(() => document.activeElement as HTMLElement | null)

  useEffect(() => {
    // Only take focus if nothing inside has claimed it. A dialog whose
    // first field is marked `autoFocus` (Add bookmark's URL box) has
    // already put the caret exactly where the user wants it; moving it to
    // the first tab-stop button would undo that on every open.
    const panel = panelRef.current
    if (!panel?.contains(document.activeElement)) {
      const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? panel)?.focus()
    }

    return () => {
      // The opener may have been unmounted while the dialog was open (a
      // row that got deleted, say) — putting focus on a detached node
      // silently does nothing, so check it is still in the document.
      if (opener && opener.isConnected) opener.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return

    const panel = panelRef.current
    if (!panel) return
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    )
    if (focusable.length === 0) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className={`max-h-full overflow-y-auto rounded-2xl border border-neutral-200 bg-white shadow-xl outline-none dark:border-neutral-800 dark:bg-neutral-900 ${className}`}
      >
        {children}
      </div>
    </div>
  )
}
