import React from 'react'

/**
 * Small blocking confirm modal for destructive actions (delete list, delete
 * tag). Deliberately minimal — no portal/focus-trap library is installed,
 * so this relies on a full-screen overlay plus a stopPropagation'd panel.
 */
export default function ConfirmDialog({
  title,
  description,
  confirmLabel = 'Delete',
  danger = true,
  onConfirm,
  onCancel
}: {
  title: string
  description: React.ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={onCancel}
      role="presentation"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[380px] rounded-xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <h2 id="confirm-dialog-title" className="mb-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {title}
        </h2>
        <div className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">{description}</div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
