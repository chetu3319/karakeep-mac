import React, { useEffect, useRef, useState } from 'react'
import Icon from './Icon'

/** Typing waits this long before searching, so a fast typist triggers one search, not one per key. */
const DEBOUNCE_MS = 150

export interface FindResult {
  /** 1-based position of the current match; 0 when there is none. */
  current: number
  total: number
}

/**
 * The find bar both readers share.
 *
 * It is a strip in the renderer rather than an overlay on the page: the live
 * page is a native view painted above everything the renderer draws, so a
 * floating bar would be hidden behind it. As a strip that takes its own
 * height out of the pane, the web view's bounds shrink to make room (the
 * ResizeObserver in WebPane reports them) and the PDF viewport simply gets
 * shorter. Same component, same look, in both.
 *
 * It owns the text of the query and the debounce; the reader owns the search.
 */
export default function FindBar({
  result,
  focusSignal,
  onQuery,
  onNext,
  onPrevious,
  onClose
}: {
  /** null until the first search has reported back. */
  result: FindResult | null
  /** Bumped by the parent when ⌘F is pressed again: re-focus and select the query. */
  focusSignal: number
  onQuery: (query: string) => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSignal])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  function change(next: string): void {
    setText(next)
    if (timer.current) clearTimeout(timer.current)
    // Clearing the box should clear the highlights at once, not after a beat.
    if (!next) onQuery('')
    else {
      timer.current = setTimeout(() => {
        timer.current = null
        onQuery(next)
      }, DEBOUNCE_MS)
    }
  }

  function step(forward: boolean): void {
    // Enter pressed inside the debounce window: search now rather than
    // stepping through the previous query's matches.
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
      onQuery(text)
      return
    }
    if (forward) onNext()
    else onPrevious()
  }

  const hasQuery = text.length > 0
  const noMatches = hasQuery && result !== null && result.total === 0

  return (
    <div
      data-testid="find-bar"
      className="flex items-center gap-1.5 border-b border-neutral-200 bg-white px-3 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900"
    >
      <Icon name="search" size={14} className="text-neutral-400" />
      <input
        ref={inputRef}
        data-testid="find-input"
        value={text}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(!e.shiftKey)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
        placeholder="Find in document"
        spellCheck={false}
        className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
      />
      <span
        data-testid="find-count"
        className={`w-20 text-right tabular-nums ${noMatches ? 'text-red-500' : 'text-neutral-500'}`}
      >
        {!hasQuery || !result ? '' : noMatches ? 'No matches' : `${result.current} of ${result.total}`}
      </span>
      <button
        type="button"
        onClick={() => step(false)}
        disabled={!result || result.total === 0}
        aria-label="Previous match"
        title="Previous match (⇧⌘G)"
        className="grid h-6 w-6 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-neutral-800"
      >
        <Icon name="chevron-up" size={14} />
      </button>
      <button
        type="button"
        onClick={() => step(true)}
        disabled={!result || result.total === 0}
        aria-label="Next match"
        title="Next match (⌘G)"
        className="grid h-6 w-6 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-neutral-800"
      >
        <Icon name="chevron-down" size={14} />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close find"
        title="Close (Esc)"
        className="grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
