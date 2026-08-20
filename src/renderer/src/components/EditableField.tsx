import React, { useEffect, useRef, useState } from 'react'

/**
 * Click-to-edit text. Shows `value` as ordinary prose until clicked, then
 * swaps in an input (or textarea) over the same footprint.
 *
 * Commit rules mirror the sidebar's inline rename: blur commits, Escape
 * cancels, and a `resolved` ref makes sure the blur that inevitably follows
 * a keyboard commit or cancel can't fire a second time and stomp it. The
 * one difference is Enter — in a multiline field Enter has to insert a
 * newline, so there the keyboard commit is ⌘/Ctrl+Enter.
 */
export default function EditableField({
  value,
  onCommit,
  placeholder,
  multiline = false,
  rows = 3,
  label,
  displayClassName = '',
  inputClassName = ''
}: {
  value: string
  onCommit: (next: string) => void
  placeholder: string
  multiline?: boolean
  rows?: number
  label: string
  displayClassName?: string
  inputClassName?: string
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const resolvedRef = useRef(false)

  // A bookmark switched underneath us (or the field was edited elsewhere)
  // while not editing: adopt the new value. Guarded on `editing` so an
  // in-flight refetch can't yank half-typed text out from under the caret.
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  function begin(): void {
    resolvedRef.current = false
    setDraft(value)
    setEditing(true)
  }

  function commit(): void {
    setEditing(false)
    if (draft === value) return
    onCommit(draft)
  }

  function cancel(): void {
    setEditing(false)
    setDraft(value)
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={begin}
        aria-label={`Edit ${label}`}
        title={`Click to edit ${label}`}
        className={`-mx-1 block w-full cursor-text rounded px-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800/60 ${displayClassName} ${
          value ? '' : 'text-neutral-400'
        }`}
      >
        {value || placeholder}
      </button>
    )
  }

  const shared = {
    autoFocus: true,
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => {
      if (resolvedRef.current) return
      resolvedRef.current = true
      commit()
    },
    className: `-mx-1 block w-full rounded border border-emerald-500 bg-transparent px-1 outline-none ${inputClassName}`
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      resolvedRef.current = true
      cancel()
      return
    }
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      resolvedRef.current = true
      commit()
    }
  }

  return multiline ? (
    <textarea {...shared} rows={rows} onKeyDown={onKeyDown} placeholder={placeholder} />
  ) : (
    <input {...shared} onKeyDown={onKeyDown} placeholder={placeholder} />
  )
}
