import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { StudyAttachment, StudyMessage, StudyThread, SyncState } from '../../../shared/study'
import { parseRefs, refLabel, type AiRef } from '../lib/aiRefs'
import { renderMarkdown } from '../lib/miniMarkdown'
import ConfirmDialog from './ConfirmDialog'
import { type RefQuality } from '../lib/revealRef'
import Icon from './Icon'
import SidePanel from './SidePanel'

export interface StudyPanelProps {
  onClose: () => void
  /** The muted line under the title: what the chat is grounded in, or reading progress. */
  scopeLine: string
  /** Whether the document text has been gathered; questions wait for it. */
  documentReady: boolean
  /** PDF page markers in the text, so reference tags read "p.4" rather than "1". */
  paged: boolean
  thread: StudyThread | null
  chatReady: boolean
  syncState: SyncState
  pending: StudyAttachment[]
  streaming: boolean
  /** Another bookmark's answer is still streaming; one at a time. */
  busy: boolean
  streamText: string
  error: string | null
  canRetry: boolean
  onSend: (question: string) => void
  onStop: () => void
  onRetry: () => void
  onClear: () => Promise<void>
  onRemoveAttachment: (index: number) => void
  onRetrySync: () => void
  /** Scrolls the reader to the passage a tag cites. */
  onRevealRef: (ref: AiRef) => Promise<RefQuality>
  /**
   * Checks a reference without moving the reader, for styling its tag once its
   * turn is done. 'unknown' when the document can't be checked right now (a
   * web page is only searchable while it is loaded), and the tag stays
   * clickable until a click finds out.
   */
  onResolveRef: (ref: AiRef) => Promise<RefQuality | 'unknown'>
}

const SUGGESTIONS = [
  'Summarize the main argument and the evidence for it',
  'What are the key terms I need to understand this?',
  'What are the limitations or open questions?'
]

const quietButton =
  'rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-200/70 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'

function attachmentLabel(a: StudyAttachment): string {
  if (a.kind === 'region') return a.label
  const quote = a.quote.length > 48 ? `${a.quote.slice(0, 48).trimEnd()}…` : a.quote
  return a.page !== undefined ? `p.${a.page} · "${quote}"` : `"${quote}"`
}

function AttachmentLabel({ attachment }: { attachment: StudyAttachment }): React.JSX.Element {
  return (
    <span className="inline-flex max-w-full items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400">
      <Icon name={attachment.kind === 'region' ? 'region' : 'paperclip'} size={11} className="flex-shrink-0" />
      <span className="truncate">{attachmentLabel(attachment)}</span>
    </span>
  )
}

/**
 * A model answer. References arrive as `[[ref …]]` markers; parseRefs turns
 * each into a sentinel that the markdown renderer swaps for a tag, and hides
 * a marker that is still being typed while the answer streams.
 */
function Answer({
  text,
  streaming,
  paged,
  onRevealRef,
  onResolveRef
}: {
  text: string
  streaming: boolean
  paged: boolean
  onRevealRef: StudyPanelProps['onRevealRef']
  onResolveRef: StudyPanelProps['onResolveRef']
}): React.JSX.Element {
  const parsed = useMemo(() => {
    const refs: AiRef[] = []
    let source = ''
    for (const seg of parseRefs(text, { streaming })) {
      if (seg.type === 'text') source += seg.text.replace(/⁣/g, '')
      else {
        refs[seg.ref.index] = seg.ref
        source += `⁣R${seg.ref.index}⁣`
      }
    }
    return { refs, source }
  }, [text, streaming])

  // How well each tag's passage was found. Component state only: it is cheap
  // to recompute and describes the document as it is open right now.
  const [quality, setQuality] = useState<Record<number, RefQuality>>({})
  const resolveRef = useRef(onResolveRef)
  resolveRef.current = onResolveRef
  useEffect(() => {
    // Once, when the turn is finished: never while it streams, never per render.
    if (streaming) return
    let cancelled = false
    void (async () => {
      for (const ref of parsed.refs) {
        if (!ref) continue
        let q: RefQuality | 'unknown'
        try {
          q = await resolveRef.current(ref)
        } catch {
          q = 'unknown'
        }
        if (cancelled) return
        if (q !== 'unknown') setQuality((prev) => (prev[ref.index] === q ? prev : { ...prev, [ref.index]: q }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [parsed, streaming])

  const body = useMemo(
    () =>
      renderMarkdown(parsed.source, {
        renderRef: (i) => {
          const ref = parsed.refs[i]
          if (!ref) return null
          const q = quality[i]
          const approx = q === 'approximate'
          const missing = q === 'missing'
          const title = missing
            ? "Couldn't find this passage"
            : approx
              ? `Jumped to page ${ref.page} — exact passage not found`
              : ref.quote
          return (
            <button
              type="button"
              disabled={missing}
              title={title}
              onClick={() =>
                void onRevealRef(ref).then((result) => {
                  setQuality((prev) => (prev[i] === result ? prev : { ...prev, [i]: result }))
                })
              }
              className={`mx-0.5 inline-block rounded border px-1 align-baseline text-[10px] leading-4 ${
                missing
                  ? 'cursor-default border-neutral-200 text-neutral-300 dark:border-neutral-800 dark:text-neutral-600'
                  : `text-neutral-500 hover:border-emerald-500 hover:text-emerald-700 dark:text-neutral-400 dark:hover:border-emerald-500 dark:hover:text-emerald-400 ${
                      approx
                        ? 'border-dashed border-neutral-400 dark:border-neutral-500'
                        : 'border-neutral-300 dark:border-neutral-700'
                    }`
              }`}
            >
              {refLabel(ref, paged)}
            </button>
          )
        }
      }),
    [parsed, quality, paged, onRevealRef]
  )
  return <>{body}</>
}

function UserTurn({ message }: { message: StudyMessage }): React.JSX.Element {
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[90%] rounded-xl border border-neutral-200 bg-neutral-100 px-3 py-2 text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
        {message.attachments && message.attachments.length > 0 && (
          <div className="mb-1 flex flex-col gap-0.5">
            {message.attachments.map((a, i) => (
              <AttachmentLabel key={i} attachment={a} />
            ))}
          </div>
        )}
        <p className="whitespace-pre-wrap">{message.text}</p>
      </div>
    </div>
  )
}

export default function StudyPanel(props: StudyPanelProps): React.JSX.Element {
  const {
    onClose,
    scopeLine,
    documentReady,
    paged,
    thread,
    chatReady,
    syncState,
    pending,
    streaming,
    busy,
    streamText,
    error,
    canRetry,
    onSend,
    onStop,
    onRetry,
    onClear,
    onRemoveAttachment,
    onRetrySync,
    onRevealRef,
    onResolveRef
  } = props
  const [input, setInput] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const scrollEndRef = useRef<HTMLDivElement>(null)
  const messages = thread?.messages ?? []
  const canAsk = documentReady && chatReady && !busy

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, streamText])

  function submit(text: string): void {
    if (!text.trim() || !canAsk) return
    onSend(text)
    setInput('')
  }

  return (
    <SidePanel
      title="Study"
      subtitle={scopeLine}
      onClose={onClose}
      closeLabel="Close Study panel"
      actions={
        messages.length > 0 ? (
          <button type="button" onClick={() => setConfirmClear(true)} className={quietButton} title="Clear this chat">
            Clear
          </button>
        ) : undefined
      }
    >
      {(syncState === 'failed' || syncState === 'newer-version') && (
        <p className="flex items-center gap-1.5 border-b border-neutral-100 px-3 py-1.5 text-[11px] text-neutral-400 dark:border-neutral-800/60">
          {syncState === 'failed' ? (
            <>
              <span>Not backed up yet</span>
              <span aria-hidden="true">·</span>
              <button type="button" onClick={onRetrySync} className="underline hover:text-neutral-600 dark:hover:text-neutral-200">
                Retry
              </button>
            </>
          ) : (
            <span>Saved by a newer version of the app</span>
          )}
        </p>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs leading-relaxed">
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col gap-1.5 pt-1">
            <p className="mb-0.5 text-[11px] font-medium text-neutral-400">Try asking</p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                disabled={!canAsk}
                onClick={() => submit(s)}
                className="rounded-lg border border-neutral-200 px-2.5 py-1.5 text-left text-xs text-neutral-700 transition hover:border-emerald-500 hover:bg-emerald-50/50 disabled:opacity-50 disabled:hover:border-neutral-200 disabled:hover:bg-transparent dark:border-neutral-800 dark:text-neutral-300 dark:hover:border-emerald-500 dark:hover:bg-emerald-950/30 dark:disabled:hover:border-neutral-800"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m) =>
          m.role === 'user' ? (
            <UserTurn key={m.id} message={m} />
          ) : (
            <div key={m.id} className="text-neutral-800 dark:text-neutral-200">
              <Answer text={m.text} streaming={false} paged={paged} onRevealRef={onRevealRef} onResolveRef={onResolveRef} />
            </div>
          )
        )}

        {streaming && (
          <div className="text-neutral-800 dark:text-neutral-200">
            {streamText ? (
              <Answer text={streamText} streaming paged={paged} onRevealRef={onRevealRef} onResolveRef={onResolveRef} />
            ) : (
              <span className="italic text-neutral-400">Reading the document…</span>
            )}
            <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-emerald-500 align-middle" />
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-red-50 p-2.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
            <p className="font-semibold">Error</p>
            <p className="mt-0.5">{error}</p>
          </div>
        )}

        {canRetry && !streaming && (
          <button
            type="button"
            onClick={onRetry}
            disabled={!canAsk}
            className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Retry
          </button>
        )}

        <div ref={scrollEndRef} />
      </div>

      <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pending.map((a, i) => (
              <span
                key={i}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-neutral-300 bg-white py-0.5 pl-2 pr-1 dark:border-neutral-700 dark:bg-neutral-800"
              >
                <AttachmentLabel attachment={a} />
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(i)}
                  aria-label="Remove attachment"
                  className="grid h-4 w-4 flex-shrink-0 place-items-center rounded-full text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
                >
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit(input)
          }}
          className="flex items-end gap-1.5"
        >
          <textarea
            value={input}
            rows={2}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter and ⌘Enter send; Shift+Enter makes a new line. A key
              // that is confirming an IME composition is not a send.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit(input)
              }
            }}
            placeholder={documentReady ? 'Ask about this document…' : 'Reading the document…'}
            className="min-w-0 flex-1 resize-none rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-800"
          />
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              className="rounded-lg bg-red-100 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-200 dark:bg-red-950 dark:text-red-300"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim() || !canAsk}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Send
            </button>
          )}
        </form>
        {busy && !streaming && (
          <p className="mt-1.5 text-[11px] text-neutral-400">Another bookmark's answer is still arriving.</p>
        )}
      </div>

      {confirmClear && (
        <ConfirmDialog
          title="Clear this chat?"
          description="This removes the conversation from this device and from the copy backed up to Karakeep."
          confirmLabel="Clear"
          onConfirm={() => {
            setConfirmClear(false)
            void onClear()
          }}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </SidePanel>
  )
}
