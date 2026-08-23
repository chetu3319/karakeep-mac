import React, { useEffect, useRef, useState } from 'react'
import type { AiChatMessage } from '../../../shared/types'
import { useAiStream } from '../lib/useAiStream'

export interface PageAiDrawerProps {
  open: boolean
  onClose: () => void
  currentPage: number
  totalPages: number
  pageText: string
  docTitle: string
}

export default function PageAiDrawer({
  open,
  onClose,
  currentPage,
  totalPages,
  pageText,
  docTitle
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

  const handleSend = (userQuestion: string): void => {
    if (!userQuestion.trim() || streaming) return
    const newHistory = [...messages, { role: 'user' as const, text: userQuestion }]
    setMessages(newHistory)
    setInput('')

    void startStream({
      mode: 'meso-page',
      prompt: userQuestion,
      pageText,
      docTitle,
      history: messages
    })
  }

  const quickAction = (promptText: string): void => {
    handleSend(promptText)
  }

  const clearChat = (): void => {
    abortStream()
    setMessages([])
  }

  return (
    <div className="flex h-full w-80 flex-col border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div>
          <div className="flex items-center gap-1.5">
            <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
            <h3 className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">
              Page AI Co-Pilot
            </h3>
          </div>
          <p className="mt-0.5 text-[11px] text-neutral-500">
            Grounded in Page {currentPage} of {totalPages || '—'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearChat}
              className="rounded p-1 text-[11px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              title="Clear chat"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label="Close AI panel"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

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
      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-xs leading-relaxed">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex flex-col ${
              m.role === 'user' ? 'items-end' : 'items-start'
            }`}
          >
            <div
              className={`max-w-[90%] whitespace-pre-wrap rounded-xl px-3 py-2 ${
                m.role === 'user'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200'
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}

        {streaming && (
          <div className="flex flex-col items-start">
            <div className="max-w-[90%] whitespace-pre-wrap rounded-xl bg-neutral-100 px-3 py-2 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
              {text}
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
            placeholder={`Ask about page ${currentPage}…`}
            disabled={streaming}
            className="flex-1 rounded-lg border border-neutral-300 bg-neutral-50 px-3 py-1.5 text-xs outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-800"
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
    </div>
  )
}
