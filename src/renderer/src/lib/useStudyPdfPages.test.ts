// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PdfDocumentReader } from './pdfDocumentReader'
import { useStudyPdfPages } from './useStudyPdfPages'

const reader = (assetId: string, text: string): PdfDocumentReader =>
  ({ assetId, getDocumentPages: () => Promise.resolve([{ page: 1, text }]) }) as unknown as PdfDocumentReader

describe('useStudyPdfPages', () => {
  it('does not answer a new PDF with the previous PDF reader pages', async () => {
    const a = reader('asset-a', 'text of A')
    const b = reader('asset-b', 'text of B')
    const h = renderHook((p: { bm: string; asset: string; r: PdfDocumentReader | null }) => useStudyPdfPages(true, p.bm, p.asset, p.r), {
      initialProps: { bm: 'A', asset: 'asset-a', r: a as PdfDocumentReader | null }
    })
    await waitFor(() => expect(h.result.current.pages).toEqual([{ page: 1, text: 'text of A' }]))

    // The bookmark switches while A's reader is still the one handed down.
    h.rerender({ bm: 'B', asset: 'asset-b', r: a })
    expect(h.result.current.pages).toBeNull()
    await act(async () => {
      await Promise.resolve()
    })
    expect(h.result.current.pages).toBeNull()

    h.rerender({ bm: 'B', asset: 'asset-b', r: b })
    await waitFor(() => expect(h.result.current.pages).toEqual([{ page: 1, text: 'text of B' }]))
  })
})
