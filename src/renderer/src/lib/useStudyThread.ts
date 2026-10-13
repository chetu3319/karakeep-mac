import { useCallback, useEffect, useRef, useState } from 'react'
import {
  STUDY_BUDGET_CHARS,
  STUDY_SCHEMA_VERSION,
  stripForPersistence,
  type StudyAttachment,
  type StudyMessage,
  type StudyThread,
  type SyncState
} from '../../../shared/study'
import { useAiStream } from './useAiStream'

/** What the model is told about the document for one question. */
export interface StudySendContext {
  documentText: string
  paged: boolean
  currentPage?: number
  docTitle: string
  sourceUrl?: string
  siteName?: string
  author?: string
  docKind?: 'pdf' | 'article' | 'note'
  /**
   * Rebuilds the document text for a smaller budget. Used once, when the
   * model rejects the request as too large.
   */
  rebuild?: (budget: number) => string
}

/** The request that is on the wire, and the thread it will be appended to. */
interface Inflight {
  bookmarkId: string
  /** The thread as sent: it already ends with the user's question. */
  base: StudyThread
  ctx: StudySendContext
  /** Already asked again with half the document. */
  retried: boolean
}

const newId = (): string => `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const emptyThread = (bookmarkId: string): StudyThread => ({
  v: STUDY_SCHEMA_VERSION,
  bookmarkId,
  updatedAt: new Date().toISOString(),
  messages: []
})

/**
 * One Study chat per bookmark: load, send, persist.
 *
 * `active` says whether the panel wants this bookmark's chat. Nothing is
 * opened (and Karakeep is not asked for a backup) until it does, but a stream
 * that has started keeps going when the panel closes or the user moves to
 * another bookmark, because the answer belongs to the bookmark it was sent
 * for: it is appended to the thread captured at send time and saved there,
 * and the visible thread is only touched if that bookmark is still showing.
 */
export function useStudyThread(
  bookmarkId: string | null,
  opts: { active: boolean; docTitle: string }
): {
  thread: StudyThread | null
  /** The saved chat has been read, so a question can be sent. */
  ready: boolean
  syncState: SyncState
  pending: StudyAttachment[]
  addAttachment(a: StudyAttachment): void
  removeAttachment(i: number): void
  seed(messages: StudyMessage[]): void
  send(question: string, ctx: StudySendContext): void
  clear(): Promise<void>
  /** An answer is streaming for this bookmark. */
  streaming: boolean
  /** Some answer is streaming, possibly for another bookmark: one at a time. */
  busy: boolean
  streamText: string
  error: string | null
  /** The last turn has no answer (it failed or was stopped) and can be asked again. */
  canRetry: boolean
  retry(ctx: StudySendContext): void
  stop(): void
  retrySync(): void
} {
  const [thread, setThread] = useState<StudyThread | null>(null)
  const [ready, setReady] = useState(false)
  const [syncState, setSyncState] = useState<SyncState>('idle')
  const [pending, setPending] = useState<StudyAttachment[]>([])
  // The bookmark a stream was started for, for as long as its text or error
  // is worth showing. Only that bookmark's panel renders them.
  const [streamFor, setStreamFor] = useState<string | null>(null)

  const bookmarkIdRef = useRef(bookmarkId)
  bookmarkIdRef.current = bookmarkId
  const docTitleRef = useRef(opts.docTitle)
  docTitleRef.current = opts.docTitle
  const threadRef = useRef(thread)
  threadRef.current = thread
  const loadedFor = useRef<string | null>(null)
  const seedQueue = useRef<StudyMessage[]>([])
  const inflight = useRef<Inflight | null>(null)

  const persist = useCallback((next: StudyThread): void => {
    void window.kk.study.save(stripForPersistence(next), docTitleRef.current)
  }, [])

  const { streaming, text, error, errorCode, startStream, abortStream } = useAiStream({
    onDone: (fullText) => {
      const sent = inflight.current
      inflight.current = null
      if (!sent) return
      const answer: StudyMessage = { id: newId(), role: 'model', text: fullText, createdAt: new Date().toISOString() }
      const finished: StudyThread = {
        ...sent.base,
        updatedAt: answer.createdAt,
        messages: [...sent.base.messages, answer]
      }
      if (bookmarkIdRef.current === sent.bookmarkId) setThread(finished)
      setStreamFor(null)
      persist(finished)
    }
  })

  // ── Per-bookmark reset ────────────────────────────────────────────────────
  useEffect(() => {
    setThread(null)
    setReady(false)
    setSyncState('idle')
    setPending([])
    loadedFor.current = null
    seedQueue.current = []
    // A failure belongs to the bookmark it happened on: coming back later must
    // not show its error above a chat that was reloaded from disk.
    if (!inflight.current) setStreamFor(null)
    return () => {
      // Leaving a bookmark (or the pane) pushes its backup now.
      if (bookmarkId) void window.kk.study.flush(bookmarkId)
    }
  }, [bookmarkId])

  // ── Load once the panel wants this bookmark ───────────────────────────────
  useEffect(() => {
    if (!bookmarkId) return
    if (!opts.active) {
      // Closing the panel is a natural point to back the chat up.
      if (loadedFor.current === bookmarkId) void window.kk.study.flush(bookmarkId)
      return
    }
    if (loadedFor.current === bookmarkId) return
    let cancelled = false
    window.kk.study
      .open(bookmarkId)
      .catch(() => null)
      .then((loaded) => {
        if (cancelled) return
        loadedFor.current = bookmarkId
        let next = loaded
        const seeds = seedQueue.current
        seedQueue.current = []
        if (seeds.length) {
          next = { ...(next ?? emptyThread(bookmarkId)), updatedAt: new Date().toISOString() }
          next = { ...next, messages: [...next.messages, ...seeds] }
          persist(next)
        }
        // A request still on the wire for this bookmark (the user went away
        // and came back) is newer than what is on disk: its base already
        // holds the question that is being answered.
        const live = inflight.current
        setThread(live && live.bookmarkId === bookmarkId ? live.base : next)
        setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [bookmarkId, opts.active, persist])

  useEffect(
    () =>
      window.kk.study.onSyncState(({ bookmarkId: id, state }) => {
        if (id === bookmarkIdRef.current) setSyncState(state)
      }),
    []
  )

  // ── Sending ───────────────────────────────────────────────────────────────
  const dispatch = useCallback(
    (sent: Inflight): void => {
      inflight.current = sent
      setStreamFor(sent.bookmarkId)
      void startStream({
        mode: 'study',
        docTitle: sent.ctx.docTitle,
        sourceUrl: sent.ctx.sourceUrl,
        siteName: sent.ctx.siteName,
        author: sent.ctx.author,
        docKind: sent.ctx.docKind,
        documentText: sent.ctx.documentText,
        studyMessages: sent.base.messages,
        currentPage: sent.ctx.currentPage,
        paged: sent.ctx.paged
      })
    },
    [startStream]
  )

  const send = useCallback(
    (question: string, ctx: StudySendContext): void => {
      const id = bookmarkIdRef.current
      const q = question.trim()
      if (!id || !q || streaming || loadedFor.current !== id) return
      const now = new Date().toISOString()
      const userTurn: StudyMessage = {
        id: newId(),
        role: 'user',
        text: q,
        ...(pending.length ? { attachments: pending } : {}),
        createdAt: now
      }
      // A question that never got an answer (it failed or was stopped) is
      // replaced by the new one: two user turns in a row are not a valid
      // conversation for the model. Retry is how to ask the same thing again.
      let earlier = threadRef.current?.messages ?? []
      if (earlier[earlier.length - 1]?.role === 'user') earlier = earlier.slice(0, -1)
      const base: StudyThread = {
        ...(threadRef.current ?? emptyThread(id)),
        updatedAt: now,
        messages: [...earlier, userTurn]
      }
      setThread(base)
      setPending([])
      dispatch({ bookmarkId: id, base, ctx, retried: false })
    },
    [dispatch, pending, streaming]
  )

  // A request that failed ends here. Too large for the model is the one
  // failure that is not final: ask once more with half the document. Any
  // other failure (or that second one) releases the request, so it can no
  // longer stand in for the saved chat.
  const willResend = (): boolean => {
    const sent = inflight.current
    return !!sent && !sent.retried && !!sent.ctx.rebuild && errorCode === 'too-large'
  }
  useEffect(() => {
    const sent = inflight.current
    if (!error || streaming || !sent) return
    if (willResend()) {
      dispatch({
        ...sent,
        retried: true,
        ctx: { ...sent.ctx, documentText: sent.ctx.rebuild!(STUDY_BUDGET_CHARS / 2) }
      })
      return
    }
    inflight.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, errorCode, streaming, dispatch])

  const retry = useCallback(
    (ctx: StudySendContext): void => {
      const id = bookmarkIdRef.current
      const current = threadRef.current
      if (!id || !current || streaming) return
      if (current.messages[current.messages.length - 1]?.role !== 'user') return
      dispatch({ bookmarkId: id, base: current, ctx, retried: false })
    },
    [dispatch, streaming]
  )

  const stop = useCallback((): void => {
    abortStream()
    inflight.current = null
    setStreamFor(null)
  }, [abortStream])

  const clear = useCallback(async (): Promise<void> => {
    const id = bookmarkIdRef.current
    if (!id) return
    if (inflight.current?.bookmarkId === id) {
      abortStream()
      inflight.current = null
      setStreamFor(null)
    }
    setThread(null)
    setPending([])
    await window.kk.study.clear(id)
  }, [abortStream])

  const addAttachment = useCallback((a: StudyAttachment): void => setPending((p) => [...p, a]), [])
  const removeAttachment = useCallback((i: number): void => setPending((p) => p.filter((_, n) => n !== i)), [])

  const seed = useCallback(
    (messages: StudyMessage[]): void => {
      const id = bookmarkIdRef.current
      if (!id || !messages.length) return
      if (loadedFor.current !== id) {
        // The panel is still opening: add them once the saved chat is read.
        seedQueue.current = [...seedQueue.current, ...messages]
        return
      }
      const base = threadRef.current ?? emptyThread(id)
      const next: StudyThread = { ...base, updatedAt: new Date().toISOString(), messages: [...base.messages, ...messages] }
      setThread(next)
      persist(next)
    },
    [persist]
  )

  const retrySync = useCallback((): void => {
    const id = bookmarkIdRef.current
    if (id) void window.kk.study.flush(id)
  }, [])

  const mine = streamFor === bookmarkId
  const last = thread?.messages[thread.messages.length - 1]
  return {
    thread,
    ready,
    syncState,
    pending,
    addAttachment,
    removeAttachment,
    seed,
    send,
    clear,
    streaming: streaming && mine,
    busy: streaming,
    streamText: mine && streaming ? text : '',
    // Hidden while the automatic smaller resend is about to start.
    error: mine && !streaming && !willResend() ? error : null,
    canRetry: !!last && last.role === 'user' && !(streaming && mine) && !willResend(),
    retry,
    stop,
    retrySync
  }
}
