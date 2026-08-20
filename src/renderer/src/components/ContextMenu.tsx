import React, { useEffect, useRef } from 'react'

export interface ContextMenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
}

/**
 * Minimal right-click menu, positioned at fixed viewport coordinates.
 * Closes on outside click, Escape, or scroll (a stale menu pinned to a now
 * moved-away row is worse than no menu).
 */
export default function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', left: x, top: y, zIndex: 60 }}
      className="min-w-[160px] overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
          className={`block w-full px-3 py-1.5 text-left text-sm ${
            item.danger
              ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
              : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
