// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STUDY_BUDGET_CHARS, STUDY_SCHEMA_VERSION, type StudyThread } from '../../../shared/study'
import { useStudyThread, type StudySendContext } from './useStudyThread'

type Handler<T> = (e: T) => void
interface Req {
  requestId: string
  documentText?: string
  studyMessages?: Array<{ role: string; text: string }>
}

const thread = (bookmarkId: string, ...texts: string[]): StudyThread => ({
  v: STUDY_SCHEMA_VERSION,
  bookmarkId,
  updatedAt: '2026-01-01T00:00:00.000Z',
  messages: texts.map((text, i) => ({
    id: `${bookmarkId}-${i}`,
    role: i % 2 === 0 ? ('user' as const) : ('model' as const),
    text,
    createdAt: '2026-01-01T00:00:00.000Z'
  }))
})

let disk: Record<string, StudyThread>
let requests: Req[]
let done: Handler<{ requestId: string; fullText: string }>
let failed: Handler<{ requestId: string; error: string; code?: 'too-large' }>
let startResult: { ok: boolean; error?: string }

beforeEach(() => {
  disk = {}
  requests = []
  startResult = { ok: true }
  ;(window as unknown as { kk: unknown }).kk = {
    ai: {
      onStreamChunk: () => () => {},
      onStreamDone: (cb: typeof done) => ((done = cb), () => {}),
      onStreamError: (cb: typeof failed) => ((failed = cb), () => {}),
      startStream: vi.fn(async (r: Req) => (requests.push(r), startResult)),
      abortStream: vi.fn(async () => {})
    },
    study: {
      open: vi.fn(async (id: string) => disk[id] ?? null),
      save: vi.fn(async (t: StudyThread) => {
        disk[t.bookmarkId] = t
      }),
      flush: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      onSyncState: () => () => {}
    }
  }
})
afterEach(() => vi.restoreAllMocks())

const ctx = (extra: Partial<StudySendContext> = {}): StudySendContext => ({
  documentText: 'DOC',
  paged: false,
  docTitle: 'T',
  ...extra
})

function mount(initial: string) {
  return renderHook(({ id }) => useStudyThread(id, { active: true, docTitle: 'T' }), {
    initialProps: { id: initial }
  })
}
const texts = (t: StudyThread | null | undefined): string[] => (t?.messages ?? []).map((m) => m.text)

describe('useStudyThread', () => {
  it('keeps the saved chat after a failed request and a trip to another bookmark', async () => {
    disk.A = thread('A', 'old q', 'old a')
    const h = mount('A')
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    act(() => h.result.current.send('new q', ctx()))
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() => failed({ requestId: requests[0].requestId, error: 'boom' }))
    await waitFor(() => expect(h.result.current.error).toBe('boom'))

    h.rerender({ id: 'B' })
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    h.rerender({ id: 'A' })
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    expect(texts(h.result.current.thread)).toEqual(['old q', 'old a'])
    expect(h.result.current.error).toBeNull()

    act(() => h.result.current.send('again', ctx()))
    await waitFor(() => expect(requests).toHaveLength(2))
    act(() => done({ requestId: requests[1].requestId, fullText: 'answer' }))
    await waitFor(() => expect(texts(disk.A)).toEqual(['old q', 'old a', 'again', 'answer']))
  })

  it('releases the request when it cannot even start (no API key)', async () => {
    disk.A = thread('A', 'q', 'a')
    startResult = { ok: false, error: 'No API key' }
    const h = mount('A')
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    act(() => h.result.current.send('next', ctx()))
    await waitFor(() => expect(h.result.current.error).toBe('No API key'))
    h.rerender({ id: 'B' })
    h.rerender({ id: 'A' })
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    expect(texts(h.result.current.thread)).toEqual(['q', 'a'])
  })

  it('saves an answer to the bookmark it was asked on after switching away', async () => {
    disk.B = thread('B', 'bq', 'ba')
    const h = mount('A')
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    act(() => h.result.current.send('question', ctx()))
    await waitFor(() => expect(requests).toHaveLength(1))

    h.rerender({ id: 'B' })
    await waitFor(() => expect(texts(h.result.current.thread)).toEqual(['bq', 'ba']))
    act(() => done({ requestId: requests[0].requestId, fullText: 'late answer' }))
    await waitFor(() => expect(texts(disk.A)).toEqual(['question', 'late answer']))
    expect(texts(h.result.current.thread)).toEqual(['bq', 'ba'])
    expect(h.result.current.streaming).toBe(false)
  })

  it('shows the pending question when coming back to a bookmark mid-stream', async () => {
    const h = mount('A')
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    act(() => h.result.current.send('q', ctx()))
    await waitFor(() => expect(requests).toHaveLength(1))
    h.rerender({ id: 'B' })
    h.rerender({ id: 'A' })
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    expect(texts(h.result.current.thread)).toEqual(['q'])
  })

  it('resends once at half the budget when too large, then shows the error', async () => {
    const rebuild = vi.fn((b: number) => `DOC@${b}`)
    const h = mount('A')
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    act(() => h.result.current.send('q', ctx({ rebuild })))
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() => failed({ requestId: requests[0].requestId, error: 'too big', code: 'too-large' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].documentText).toBe(`DOC@${STUDY_BUDGET_CHARS / 2}`)
    expect(requests[1].studyMessages).toEqual(requests[0].studyMessages)

    act(() => failed({ requestId: requests[1].requestId, error: 'still too big', code: 'too-large' }))
    await waitFor(() => expect(h.result.current.error).toBe('still too big'))
    expect(requests).toHaveLength(2)
    expect(rebuild).toHaveBeenCalledTimes(1)
  })

  it('replaces an unanswered question instead of sending two user turns in a row', async () => {
    const h = mount('A')
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    act(() => h.result.current.send('first', ctx()))
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() => failed({ requestId: requests[0].requestId, error: 'boom' }))
    await waitFor(() => expect(h.result.current.error).toBe('boom'))

    act(() => h.result.current.send('second', ctx()))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].studyMessages?.map((m) => `${m.role}:${m.text}`)).toEqual(['user:second'])
  })

  it('keeps a seeded exchange that arrives while an answer streams', async () => {
    disk.A = thread('A', 'old q', 'old a')
    const h = mount('A')
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    act(() => h.result.current.send('new q', ctx()))
    await waitFor(() => expect(requests).toHaveLength(1))
    const seeded = thread('S', 'seed q', 'seed a').messages
    act(() => h.result.current.seed(seeded))
    act(() => done({ requestId: requests[0].requestId, fullText: 'answer' }))
    await waitFor(() => expect(texts(disk.A)).toEqual(['old q', 'old a', 'new q', 'answer', 'seed q', 'seed a']))
    expect(texts(h.result.current.thread)).toEqual(['old q', 'old a', 'new q', 'answer', 'seed q', 'seed a'])
  })

  it('still adds a seeded exchange when the streaming request fails', async () => {
    disk.A = thread('A', 'old q', 'old a')
    const h = mount('A')
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    act(() => h.result.current.send('new q', ctx()))
    await waitFor(() => expect(requests).toHaveLength(1))
    act(() => h.result.current.seed(thread('S', 'seed q', 'seed a').messages))
    act(() => failed({ requestId: requests[0].requestId, error: 'boom' }))
    await waitFor(() => expect(texts(disk.A)).toEqual(['old q', 'old a', 'new q', 'seed q', 'seed a']))
  })
})
