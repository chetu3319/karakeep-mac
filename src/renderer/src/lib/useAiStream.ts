import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiChatMessage, AiMode, AiStreamChunk, AiStreamDone, AiStreamError, AiStreamRequest } from '../../../shared/types'

export interface StartStreamOptions {
  mode: AiMode
  selectionText?: string
  surroundingContext?: string
  pageText?: string
  docTitle?: string
  prompt?: string
  history?: AiChatMessage[]
}

export function useAiStream(options?: {
  onDone?: (fullText: string) => void
  onError?: (error: string) => void
}) {
  const [streaming, setStreaming] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const callbacksRef = useRef(options)
  callbacksRef.current = options

  const abortStream = useCallback(() => {
    if (activeRequestIdRef.current) {
      void window.kk.ai.abortStream(activeRequestIdRef.current)
      activeRequestIdRef.current = null
    }
    setStreaming(false)
  }, [])

  const reset = useCallback(() => {
    abortStream()
    setText('')
    setError(null)
  }, [abortStream])

  useEffect(() => {
    const unsubChunk = window.kk.ai.onStreamChunk((chunk: AiStreamChunk) => {
      if (chunk.requestId === activeRequestIdRef.current) {
        setText((prev) => prev + chunk.delta)
      }
    })

    const unsubDone = window.kk.ai.onStreamDone((done: AiStreamDone) => {
      if (done.requestId === activeRequestIdRef.current) {
        setStreaming(false)
        activeRequestIdRef.current = null
        setText(done.fullText)
        callbacksRef.current?.onDone?.(done.fullText)
      }
    })

    const unsubError = window.kk.ai.onStreamError((err: AiStreamError) => {
      if (err.requestId === activeRequestIdRef.current) {
        setStreaming(false)
        activeRequestIdRef.current = null
        setError(err.error)
        callbacksRef.current?.onError?.(err.error)
      }
    })

    return () => {
      unsubChunk()
      unsubDone()
      unsubError()
      if (activeRequestIdRef.current) {
        void window.kk.ai.abortStream(activeRequestIdRef.current)
      }
    }
  }, [])

  const startStream = useCallback(
    async (opts: StartStreamOptions) => {
      abortStream()
      const reqId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      activeRequestIdRef.current = reqId
      setStreaming(true)
      setText('')
      setError(null)

      const request: AiStreamRequest = {
        requestId: reqId,
        ...opts
      }

      const res = await window.kk.ai.startStream(request)
      if (!res.ok) {
        setStreaming(false)
        setError(res.error || 'Failed to start AI generation')
        callbacksRef.current?.onError?.(res.error || 'Failed to start AI generation')
      }
    },
    [abortStream]
  )

  return {
    streaming,
    text,
    error,
    startStream,
    abortStream,
    reset,
    setText
  }
}
