import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { placePopover } from '../../../shared/highlightUi'
import type { AiMode } from '../../../shared/types'
import { useAiStream } from '../lib/useAiStream'
import { renderMarkdown } from '../lib/miniMarkdown'

export interface SelectionAiHUDProps {
  anchor: () => DOMRect | null
  selectionText: string
  surroundingContext?: string
  pageText?: string
  docTitle?: string
  initialMode?: AiMode
  onDismiss: () => void
  onSaveAsHighlight?: (note: string) => Promise<void>
  sourceUrl?: string
  siteName?: string
  author?: string
  docKind?: 'pdf' | 'article' | 'note'
}

export default function SelectionAiHUD({
  anchor,
  selectionText,
  surroundingContext,
  pageText,
  docTitle,
  initialMode = 'micro-explain',
  onDismiss,
  onSaveAsHighlight,
  sourceUrl,
  siteName,
  author,
  docKind
}: SelectionAiHUDProps): React.JSX.Element {
  const [host] = useState(() => document.createElement('div'))
  const el = useRef<HTMLDivElement>(null)
  const [activeMode, setActiveMode] = useState<AiMode>(initialMode)
  const [customPrompt, setCustomPrompt] = useState('')
  const [showInput, setShowInput] = useState(false)
  const [copied, setCopied] = useState(false)
  const [savedNote, setSavedNote] = useState(false)
  const [savingNote, setSavingNote] = useState(false)

  const { streaming, text, error, startStream, abortStream } = useAiStream()

  // Run initial AI query on mount
  useEffect(() => {
    void startStream({
      mode: initialMode,
      selectionText,
      surroundingContext,
      pageText,
      docTitle,
      sourceUrl,
      siteName,
      author,
      docKind
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMode, selectionText, surroundingContext, pageText, docTitle, startStream])

  // Positioning
  useLayoutEffect(() => {
    const place = (): void => {
      if (!el.current) return
      const rect = anchor()
      el.current.style.visibility = rect ? 'visible' : 'hidden'
      if (rect) placePopover(el.current, rect)
    }
    place()

    let frame = 0
    const queue = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        place()
      })
    }
    window.addEventListener('scroll', queue, true)
    window.addEventListener('resize', queue)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', queue, true)
      window.removeEventListener('resize', queue)
    }
  })

  useEffect(() => {
    host.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;'
    document.body.appendChild(host)
    return () => host.remove()
  }, [host])

  // Outside click & Esc handling
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (el.current && e.composedPath().includes(el.current)) return
      if ((e.target as Element)?.closest?.('[data-kk-ai]')) return
      onDismiss()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }

    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', onDown, true)
      document.addEventListener('keydown', onKey)
    }, 60)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onDismiss])

  const triggerMode = (mode: AiMode): void => {
    setActiveMode(mode)
    setShowInput(false)
    void startStream({
      mode,
      selectionText,
      surroundingContext,
      pageText,
      docTitle,
      sourceUrl,
      siteName,
      author,
      docKind
    })
  }

  const handleCustomSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!customPrompt.trim()) return
    setActiveMode('custom')
    void startStream({
      mode: 'custom',
      prompt: customPrompt.trim(),
      selectionText,
      surroundingContext,
      pageText,
      docTitle,
      sourceUrl,
      siteName,
      author,
      docKind
    })
  }

  const copyText = async (): Promise<void> => {
    if (!text) return
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const saveAsNote = async (): Promise<void> => {
    if (!text || !onSaveAsHighlight || savingNote) return
    setSavingNote(true)
    try {
      await onSaveAsHighlight(text)
      setSavedNote(true)
      setTimeout(() => setSavedNote(false), 2500)
    } finally {
      setSavingNote(false)
    }
  }

  return createPortal(
    <div
      ref={el}
      data-no-interaction
      data-kk-ai-hud
      // The host is `pointer-events: none` (deliberate — see the effect
      // below) so it never swallows clicks meant for the page underneath a
      // full-viewport fixed overlay. That `none` inherits straight through
      // to every descendant unless something in the panel opts back in, the
      // same way the shared `.kh-pop` popover style does with its own
      // `pointer-events: auto` rule (src/shared/highlightUi.ts). This panel
      // is plain Tailwind rather than `.kh-pop`, so it has to opt in here
      // instead — without it every button, tab, and input in the HUD is
      // click-through, and the resulting click lands on the document
      // underneath and immediately dismisses the HUD via the outside-click
      // handler below.
      className="pointer-events-auto fixed z-50 flex max-h-[380px] w-[380px] flex-col rounded-xl border border-neutral-200 bg-white/95 p-3.5 shadow-2xl backdrop-blur-md transition-shadow dark:border-neutral-700/80 dark:bg-neutral-900/95 dark:text-neutral-100"
      onPointerDown={(e) => {
        // Prevent clearing text selection on click
        if (!(e.target as HTMLElement).closest('input, textarea')) {
          e.stopPropagation()
        }
      }}
    >
      {/* Header Tabs / Mode Switcher */}
      <div className="mb-2.5 flex items-center justify-between border-b border-neutral-200/80 pb-2 dark:border-neutral-800">
        <div className="flex items-center gap-1">
          {/* Explain / Dejargonify / Define is the exact order and naming
              the product spec asks for; Math stays as a fourth mode because
              it earns its place for the arxiv/paper use case even though
              the spec only names three. The PDF pane's SelectionMenu and
              preload/webpane.ts's in-page popover both mirror this same
              order and labels, so the two AI surfaces read as one feature. */}
          <button
            type="button"
            onClick={() => triggerMode('micro-explain')}
            className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              activeMode === 'micro-explain' && !showInput
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300'
                : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
            }`}
          >
            💡 Explain
          </button>
          <button
            type="button"
            data-kk-ai-mode="micro-dejargon"
            onClick={() => triggerMode('micro-dejargon')}
            className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              activeMode === 'micro-dejargon' && !showInput
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300'
                : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
            }`}
          >
            ⚡ Dejargonify
          </button>
          <button
            type="button"
            onClick={() => triggerMode('micro-define')}
            className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              activeMode === 'micro-define' && !showInput
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300'
                : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
            }`}
          >
            📖 Define
          </button>
          <button
            type="button"
            onClick={() => triggerMode('micro-formula')}
            className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              activeMode === 'micro-formula' && !showInput
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300'
                : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
            }`}
          >
            🧮 Math
          </button>
          <button
            type="button"
            onClick={() => setShowInput((prev) => !prev)}
            className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              showInput
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300'
                : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
            }`}
          >
            💬 Ask
          </button>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          aria-label="Dismiss AI assistance"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Optional Custom Input */}
      {showInput && (
        <form onSubmit={handleCustomSubmit} className="mb-2.5 flex gap-1.5">
          <input
            type="text"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="Ask anything about this selection…"
            autoFocus
            className="flex-1 rounded-md border border-neutral-300 bg-neutral-50 px-2.5 py-1 text-xs outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-800"
          />
          <button
            type="submit"
            disabled={streaming || !customPrompt.trim()}
            className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Ask
          </button>
        </form>
      )}

      {/* Selected text pill (truncated preview) */}
      <div className="mb-2 max-h-12 overflow-hidden text-ellipsis whitespace-pre-line rounded bg-neutral-100 px-2 py-1 text-[11px] italic text-neutral-500 dark:bg-neutral-800/80 dark:text-neutral-400">
        "{selectionText.slice(0, 140)}{selectionText.length > 140 ? '…' : ''}"
      </div>

      {/* Content Stream Area */}
      <div className="min-h-[90px] flex-1 overflow-y-auto pr-1 text-xs leading-relaxed text-neutral-800 dark:text-neutral-200">
        {error ? (
          <div className="rounded bg-red-50 p-2 text-red-700 dark:bg-red-950/40 dark:text-red-300">
            <p className="font-semibold">AI Error</p>
            <p className="mt-0.5">{error}</p>
          </div>
        ) : (
          <div>
            {text ? renderMarkdown(text) : null}
            {streaming && (
              <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse bg-emerald-500 align-middle" />
            )}
            {!text && streaming && (
              <span className="text-neutral-400 italic">Thinking with Gemini…</span>
            )}
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="mt-2.5 flex items-center justify-between border-t border-neutral-200/80 pt-2 text-[11px] dark:border-neutral-800">
        <div className="flex gap-2">
          {onSaveAsHighlight && (
            <button
              type="button"
              disabled={!text || streaming || savingNote}
              onClick={() => void saveAsNote()}
              className="flex items-center gap-1 rounded px-2 py-1 font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 dark:text-emerald-400 dark:hover:bg-emerald-950/50"
              title="Highlight this text and attach this explanation as a note"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3 w-3">
                <path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              {savedNote ? 'Saved to Note!' : savingNote ? 'Saving…' : 'Save as Note'}
            </button>
          )}

          <button
            type="button"
            disabled={!text}
            onClick={() => void copyText()}
            className="flex items-center gap-1 rounded px-2 py-1 text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        {streaming && (
          <button
            type="button"
            onClick={abortStream}
            className="rounded px-2 py-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            Stop
          </button>
        )}
      </div>
    </div>,
    host
  )
}
