import React, { useEffect, useState } from 'react'
import { ICON_CHECK, ICON_COPY, ICON_NOTE } from '../../../shared/highlightUi'
import { useAiStream } from '../lib/useAiStream'
import { renderMarkdown } from '../lib/miniMarkdown'
import type { InlineMode } from '../../../shared/inlineAnswer'

export interface InlineAnswerProps {
  mode: InlineMode
  /** The question, for `custom` (Ask…). */
  prompt?: string
  selectionText: string
  surroundingContext: string
  pageText: string
  docTitle: string
  docKind: 'pdf' | 'article' | 'note'
  sourceUrl?: string
  author?: string
  onSaveAsNote(text: string): Promise<void>
  /** Omit to hide "Continue in Study" (no Study to continue in). */
  onContinue?(answer: string): void
}

function LineIcon({ path }: { path: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d={path} />
    </svg>
  )
}

/**
 * The answer body that drops down under the selection toolbar, inside the same
 * card. It streams on mount, so the caller restarts it by changing its `key`
 * (mode + question) rather than by prop changes.
 */
export default function InlineAnswer({
  mode,
  prompt,
  selectionText,
  surroundingContext,
  pageText,
  docTitle,
  docKind,
  sourceUrl,
  author,
  onSaveAsNote,
  onContinue
}: InlineAnswerProps): React.JSX.Element {
  const { streaming, text, error, startStream, abortStream } = useAiStream()
  const [copied, setCopied] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'failed'>('idle')

  useEffect(() => {
    // startStream aborts any earlier request, so a strict-mode double run
    // leaves exactly one live stream; useAiStream aborts it on unmount.
    void startStream({
      mode,
      prompt,
      selectionText,
      surroundingContext,
      pageText,
      docTitle,
      docKind,
      sourceUrl,
      author
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  const ready = !!text && !streaming && !error

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => undefined)
  }

  const save = async (): Promise<void> => {
    setSaveState('saving')
    try {
      await onSaveAsNote(text)
      // Success closes the toolbar (the parent clears the selection).
    } catch {
      setSaveState('failed')
    }
  }

  return (
    <div className="kh-ans-wrap" data-kk-inline-answer="">
      <div className="kh-ans" tabIndex={0}>
        {error ? (
          <div className="kh-ans-error">
            <strong>Could not get an answer</strong>
            <div>{error}</div>
          </div>
        ) : (
          <>
            {text ? renderMarkdown(text) : null}
            {streaming && !text && <span className="kh-hint">Thinking…</span>}
            {streaming && text && <span className="kh-caret" />}
          </>
        )}
      </div>
      <div className="kh-ans-foot">
        <button type="button" className="kh-btn" disabled={!text} onClick={copy}>
          <LineIcon path={copied ? ICON_CHECK : ICON_COPY} />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
        <button type="button" className="kh-btn" disabled={!ready || saveState === 'saving'} onClick={() => void save()}>
          <LineIcon path={ICON_NOTE} />
          <span>{saveState === 'saving' ? 'Saving…' : saveState === 'failed' ? 'Save failed, retry' : 'Save as note'}</span>
        </button>
        <div className="kh-spacer" />
        {streaming && (
          <button type="button" className="kh-btn" onClick={abortStream}>
            <span>Stop</span>
          </button>
        )}
        {onContinue && (
          <button type="button" className="kh-btn kh-go" disabled={!ready} onClick={() => onContinue(text)}>
            <span>Continue in Study</span>
            <span aria-hidden="true">→</span>
          </button>
        )}
      </div>
    </div>
  )
}
