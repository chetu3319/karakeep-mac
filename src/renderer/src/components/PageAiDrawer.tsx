// TODO(ai-chat-persistence): chats in this drawer are ephemeral — they live
// only in this component's state and vanish on close, tab switch, or app
// restart. Karakeep's API has no chat/conversation resource to persist them
// to (see BRIEF.md's verified API surface), so saving would need a local
// store here in the app, keyed by bookmark id, most likely a JSON file
// alongside main/store.ts's config the same way listOrder is persisted
// today. That also means deciding a retention/size policy (a long-running
// research session could accumulate a lot of chat text) and whether history
// should survive a bookmark's content being re-crawled. Out of scope for
// now — see the footer note below and the bullet in README.md.
import React, { useEffect, useRef, useState } from 'react'
import type { AiChatMessage } from '../../../shared/types'
import { useAiStream } from '../lib/useAiStream'
import { renderMarkdown } from '../lib/miniMarkdown'
import SidePanel from './SidePanel'

export interface PageAiDrawerProps {
  open: boolean
  onClose: () => void
  /**
   * What this chat is grounded in, already phrased for display — e.g.
   * "page 4 of 21" for a PDF, or "this article" / "this note" for the web
   * surfaces. Replaces the old `currentPage`/`totalPages` pair, which only
   * ever made sense for the PDF pane: DetailPane was passing the literal
   * `currentPage={1} totalPages={1}` for every non-PDF bookmark, so every
   * article chat claimed "Page 1 of 1" regardless of what was actually
   * being read.
   */
  scopeLabel: string
  pageText: string
  docTitle: string
  sourceUrl?: string
  siteName?: string
  author?: string
  docKind?: 'pdf' | 'article' | 'note'
}

export default function PageAiDrawer({
  open,
  onClose,
  scopeLabel,
  pageText,
  docTitle,
  sourceUrl,
  siteName,
  author,
  docKind
}: PageAiDrawerProps): React.JSX.Element | null {
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [input, setInput] = useState('')
  const scrollEndRef = useRef<HTMLDivElement>(null)

  const { streaming, text, error, startStream, abortStream } = useAiStream({
    onDone: (fullText) => {
      setMessages((prev) => [...prev, { role: 'model', text: fullText }])
    }
  })

  // Auto scroll to bottom of chat
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, text])

  if (!open) return null

  // `history` is everything the model should see *before* the turn being
  // sent — the caller decides what "before" means, because a retry sends
  // the same trailing user message with the turns before it as history,
  // while a fresh send appends a new user message and uses everything that
  // came before it.
  function send(prompt: string, history: AiChatMessage[]): void {
    void startStream({
      mode: 'meso-page',
      prompt,
      pageText,
      docTitle,
      sourceUrl,
      siteName,
      author,
      docKind,
      history
    })
  }

  const handleSend = (userQuestion: string): void => {
    if (!userQuestion.trim() || streaming) return
    const priorHistory = messages
    setMessages((prev) => [...prev, { role: 'user', text: userQuestion }])
    setInput('')
    send(userQuestion, priorHistory)
  }

  /**
   * A failed turn used to leave the user's message stranded in the
   * transcript with no way forward short of retyping it. The failed turn is
   * always the last message (nothing gets appended on error), so retrying
   * just means replaying it with the same history it was sent with the
   * first time.
   */
  const handleRetry = (): void => {
    if (streaming || messages.length === 0) return
    const last = messages[messages.length - 1]
    if (last.role !== 'user') return
    send(last.text, messages.slice(0, -1))
  }

  const quickAction = (promptText: string): void => {
    handleSend(promptText)
  }

  const clearChat = (): void => {
    abortStream()
    setMessages([])
  }

  return (
    <SidePanel
      title="AI Co-Pilot"
      subtitle={`Grounded in ${scopeLabel}`}
      onClose={onClose}
      closeLabel="Close AI panel"
      actions={
        messages.length > 0 ? (
          <button
            type="button"
            onClick={clearChat}
            className="rounded px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-200/70 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            title="Clear chat"
          >
            Clear
          </button>
        ) : undefined
      }
    >
      {/* Ephemeral-chat notice — quiet, so it doesn't compete with the
          quick-action chips, but present so nobody is surprised the
          conversation is gone after closing the drawer. See the
          TODO(ai-chat-persistence) at the top of this file. */}
      <p className="border-b border-neutral-100 px-3 py-1.5 text-[10px] text-neutral-400 dark:border-neutral-800/60">
        Chats aren't saved yet — closing this panel clears them.
      </p>

      {/* Suggested Quick Prompt Chips */}
      {messages.length === 0 && !streaming && (
        <div className="border-b border-neutral-100 p-3 dark:border-neutral-800/60">
          <p className="mb-2 text-[11px] font-medium text-neutral-400">Quick Actions for this page:</p>
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => quickAction('Summarize the core findings and arguments on this page in 3 concise bullet points.')}
              className="rounded-lg border border-neutral-200 bg-neutral-50/50 px-2.5 py-1.5 text-left text-xs text-neutral-700 transition hover:border-emerald-500 hover:bg-emerald-50/50 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-300 dark:hover:border-emerald-500 dark:hover:bg-emerald-950/30"
            >
              📄 Summarize this page
            </button>
            <button
              type="button"
              onClick={() => quickAction('Explain any figures, tables, or mathematical formulas mentioned on this page.')}
              className="rounded-lg border border-neutral-200 bg-neutral-50/50 px-2.5 py-1.5 text-left text-xs text-neutral-700 transition hover:border-emerald-500 hover:bg-emerald-50/50 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-300 dark:hover:border-emerald-500 dark:hover:bg-emerald-950/30"
            >
              📊 Explain figures & methods
            </button>
            <button
              type="button"
              onClick={() => quickAction('What are the key technical terms or concepts introduced here and how do they work?')}
              className="rounded-lg border border-neutral-200 bg-neutral-50/50 px-2.5 py-1.5 text-left text-xs text-neutral-700 transition hover:border-emerald-500 hover:bg-emerald-50/50 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-300 dark:hover:border-emerald-500 dark:hover:bg-emerald-950/30"
            >
              🔍 Clarify key terminology
            </button>
          </div>
        </div>
      )}

      {/* Chat Messages */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs leading-relaxed">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex flex-col ${
              m.role === 'user' ? 'items-end' : 'items-start'
            }`}
          >
            <div
              className={`max-w-[90%] rounded-xl px-3 py-2 ${
                m.role === 'user'
                  ? 'whitespace-pre-wrap bg-emerald-600 text-white'
                  : 'bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200'
              }`}
            >
              {m.role === 'model' ? renderMarkdown(m.text) : m.text}
            </div>
          </div>
        ))}

        {streaming && (
          <div className="flex flex-col items-start">
            <div className="max-w-[90%] rounded-xl bg-neutral-100 px-3 py-2 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
              {text ? renderMarkdown(text) : null}
              <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-emerald-500 align-middle" />
              {!text && (
                <span className="italic text-neutral-400">Analyzing with Gemini…</span>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-red-50 p-2.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
            <p className="font-semibold">Error</p>
            <p className="mt-0.5">{error}</p>
            <button
              type="button"
              onClick={handleRetry}
              className="mt-1.5 rounded border border-red-300 px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
            >
              Retry
            </button>
          </div>
        )}

        <div ref={scrollEndRef} />
      </div>

      {/* Input bar */}
      <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSend(input)
          }}
          className="flex items-center gap-1.5"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask about ${scopeLabel}…`}
            disabled={streaming}
            className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-xs outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-800"
          />
          {streaming ? (
            <button
              type="button"
              onClick={abortStream}
              className="rounded-lg bg-red-100 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-200 dark:bg-red-950 dark:text-red-300"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Send
            </button>
          )}
        </form>
      </div>
    </SidePanel>
  )
}
