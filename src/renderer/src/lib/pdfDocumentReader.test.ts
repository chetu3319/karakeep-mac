import { describe, expect, it, vi } from 'vitest'
import { createPdfDocumentReader } from './pdfDocumentReader'

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

function pane(pageCount = 3) {
  const state = {
    doc: null as { pageCount: number } | null,
    index: false,
    page: 1,
    failure: null as string | null
  }
  const reader = createPdfDocumentReader(
    {
      getDocument: () => state.doc,
      hasIndex: () => state.index,
      getPageText: async (i) => ` text ${i} `,
      getCurrentPage: () => state.page,
      getFailure: () => state.failure
    },
    { pollMs: 2 }
  )
  return { state, reader, pageCount }
}

describe('createPdfDocumentReader', () => {
  it('waits for the document and the text index instead of failing', async () => {
    const { state, reader } = pane()
    const progress: Array<[number, number]> = []
    const pages = reader.getDocumentPages((d, t) => progress.push([d, t]))
    await tick(20) // asked before the document exists
    state.doc = { pageCount: 3 }
    await tick(20) // document open, index not built yet
    state.index = true
    expect(await pages).toEqual([
      { page: 1, text: 'text 0' },
      { page: 2, text: 'text 1' },
      { page: 3, text: 'text 2' }
    ])
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]])
  })

  it('is memoised and drops progress listeners when the read ends', async () => {
    const { state, reader } = pane()
    state.doc = { pageCount: 2 }
    state.index = true
    const seen: number[] = []
    const first = reader.getDocumentPages(() => seen.push(1))
    const second = reader.getDocumentPages(() => seen.push(2))
    expect(second).toBe(first)
    await first
    const count = seen.length
    expect(await reader.getDocumentPages(() => seen.push(3))).toHaveLength(2)
    expect(seen.length).toBe(count)
  })

  it('starts over when the document is swapped mid-read', async () => {
    const { state, reader } = pane()
    state.doc = { pageCount: 2 }
    const pages = reader.getDocumentPages(() => {})
    await tick(10)
    state.doc = { pageCount: 4 }
    state.index = true
    expect(await pages).toHaveLength(4)
  })

  it('rejects when disposed while still waiting', async () => {
    const { reader } = pane()
    const pending = reader.getDocumentPages(() => {})
    reader.dispose()
    await expect(pending).rejects.toThrow()
  })

  it('rejects when the document fails to open', async () => {
    const { state, reader } = pane()
    const pending = reader.getDocumentPages(() => {})
    await tick(10)
    state.failure = 'The PDF could not be opened'
    await expect(pending).rejects.toThrow('could not be opened')
  })

  it('rejects when the text index fails after the document opened', async () => {
    const { state, reader } = pane()
    state.doc = { pageCount: 2 }
    const pending = reader.getDocumentPages(() => {})
    await tick(10)
    state.failure = 'The PDF text could not be read'
    await expect(pending).rejects.toThrow('text could not be read')
  })

  it('gives up after the timeout as a backstop', async () => {
    vi.useFakeTimers()
    try {
      const reader = createPdfDocumentReader(
        { getDocument: () => null, hasIndex: () => false, getPageText: async () => '', getCurrentPage: () => 1, getFailure: () => null },
        { pollMs: 50, timeoutMs: 1000 }
      )
      const pending = reader.getDocumentPages(() => {})
      const assertion = expect(pending).rejects.toThrow('Timed out')
      await vi.advanceTimersByTimeAsync(1200)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('tries again after a failed read', async () => {
    const { state, reader } = pane()
    state.failure = 'broken'
    await expect(reader.getDocumentPages(() => {})).rejects.toThrow('broken')
    state.failure = null
    state.doc = { pageCount: 1 }
    state.index = true
    expect(await reader.getDocumentPages(() => {})).toHaveLength(1)
  })

  it('whenReady resolves once the index exists, and gives up after its wait', async () => {
    const { state, reader } = pane()
    expect(await reader.whenReady(20)).toBeNull()
    const ready = reader.whenReady(500)
    state.doc = { pageCount: 4 }
    state.index = true
    expect(await ready).toEqual({ pageCount: 4 })
  })
})
