import React from 'react'
import Modal from './Modal'

/**
 * Blocking confirm for destructive actions (delete bookmark, delete list,
 * delete tag, sign out).
 *
 * Escape, focus containment and focus restore all come from Modal — this
 * is just the content. Cancel is focused first rather than the destructive
 * button, so an Enter pressed out of habit doesn't delete anything.
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
    <Modal onClose={onCancel} labelledBy="confirm-dialog-title" role="alertdialog" className="w-[380px] p-5">
      <h2 id="confirm-dialog-title" className="mb-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        {title}
      </h2>
      <div className="mb-4 text-sm text-neutral-600 dark:text-neutral-400">{description}</div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
            danger
              ? 'bg-red-600 hover:bg-red-700 focus-visible:outline-red-500'
              : 'bg-emerald-600 hover:bg-emerald-700 focus-visible:outline-emerald-500'
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
