import { useEffect, useState } from 'react'
import type { PdfDocumentReader } from './pdfDocumentReader'
import type { DocPage } from './studyContext'

/**
 * The open PDF's text for Study, with extraction progress.
 *
 * Only a reader that serves `assetId` counts: when the user moves from one PDF
 * to another the previous reader is still handed down for a moment, and its
 * cached pages must never be taken for the new document's. Pages are stored
 * with the bookmark and asset they were read from and only returned when both
 * match. An unreadable PDF yields an empty page list (Study then answers from
 * the title); `null` means the text is not available yet.
 */
export function useStudyPdfPages(
  enabled: boolean,
  bookmarkId: string | null,
  assetId: string | null,
  reader: PdfDocumentReader | null
): { pages: DocPage[] | null; progress: { done: number; total: number } | null } {
  const [result, setResult] = useState<{ bookmarkId: string; assetId: string; pages: DocPage[] } | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  // The reader for the document being shown, not one left over from the last.
  const live = reader && reader.assetId === assetId ? reader : null

  useEffect(() => {
    if (!enabled || !bookmarkId || !assetId || !live) return
    let cancelled = false
    setProgress(null)
    live
      .getDocumentPages((done, total) => {
        if (!cancelled) setProgress({ done, total })
      })
      .then((pages) => {
        if (!cancelled) setResult({ bookmarkId, assetId, pages })
      })
      .catch(() => {
        if (!cancelled) setResult({ bookmarkId, assetId, pages: [] })
      })
    return () => {
      cancelled = true
    }
  }, [enabled, bookmarkId, assetId, live])

  const pages = result && result.bookmarkId === bookmarkId && result.assetId === assetId ? result.pages : null
  return { pages, progress: pages ? null : progress }
}
