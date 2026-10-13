import type { DocPage } from './studyContext'

/** What Study needs from an open PDF: every page's text, and where the reader is. */
export interface PdfDocumentReader {
  /**
   * Text of every page, 1-based. Extracted once per document and then served
   * from memory; `onProgress` is called as pages finish. Rejects if the pane
   * is closed before the read ends.
   */
  getDocumentPages(onProgress: (done: number, total: number) => void): Promise<DocPage[]>
  /** 1-based page the reader is on. */
  getCurrentPage(): number
  /**
   * Resolves with the page count once the document is open and its text index
   * exists, or null if that does not happen within `timeoutMs` (or never can).
   */
  whenReady(timeoutMs: number): Promise<{ pageCount: number } | null>
  /** Text of one page, 0-based (empty until the text index exists). */
  getPageText(page0: number): Promise<string>
  /** Scrolls to a page (0-based) and, given a character range of its text, flashes it. Never saves anything. */
  reveal(page0: number, start?: number, end?: number): void
}

/** The live state of a PDF pane, read when it is needed rather than captured. */
export interface PdfPaneSource {
  /** The open document, or null while it is still loading. */
  getDocument(): { pageCount: number } | null
  /** Page text is empty until the text index exists. */
  hasIndex(): boolean
  /** Text of one page, 0-based. */
  getPageText(page: number): Promise<string>
  getCurrentPage(): number
  /** Why the document can never be read (it failed to open, or its text index failed), or null. */
  getFailure(): string | null
  /** Scroll to a page and flash a character range of its text. */
  reveal?(page0: number, start?: number, end?: number): void
}

/**
 * Builds the reader a PDF pane hands to Study. The pane registers it as soon
 * as it mounts, which is before the document has opened, so extraction waits
 * for the document and then the text index instead of failing; if the pane's
 * document is swapped part-way it starts over on the new one. `dispose`
 * abandons any read still waiting. A read that can never finish (the PDF
 * failed to open or to index, or nothing happened within `timeoutMs`) rejects
 * so the caller can carry on without document text.
 */
export function createPdfDocumentReader(
  src: PdfPaneSource,
  { pollMs = 50, timeoutMs = 60_000 }: { pollMs?: number; timeoutMs?: number } = {}
): PdfDocumentReader & { dispose(): void } {
  let disposed = false
  let memo: { promise: Promise<DocPage[]>; listeners: Set<(done: number, total: number) => void> } | null = null

  const waitFor = async (ready: () => boolean, since: number): Promise<void> => {
    while (!ready()) {
      if (disposed) throw new Error('The PDF pane was closed')
      const failure = src.getFailure()
      if (failure) throw new Error(failure)
      if (Date.now() - since > timeoutMs) throw new Error('Timed out waiting for the PDF')
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  async function extract(listeners: Set<(done: number, total: number) => void>): Promise<DocPage[]> {
    for (;;) {
      const since = Date.now()
      await waitFor(() => !!src.getDocument(), since)
      const doc = src.getDocument()!
      await waitFor(() => src.hasIndex() || src.getDocument() !== doc, since)
      if (src.getDocument() !== doc) continue
      const pages: DocPage[] = []
      let swapped = false
      for (let i = 0; i < doc.pageCount; i++) {
        if (disposed) throw new Error('The PDF pane was closed')
        if (src.getDocument() !== doc) {
          swapped = true
          break
        }
        pages.push({ page: i + 1, text: (await src.getPageText(i)).trim() })
        listeners.forEach((l) => l(i + 1, doc.pageCount))
      }
      if (!swapped) return pages
    }
  }

  return {
    getDocumentPages(onProgress) {
      if (memo) {
        memo.listeners.add(onProgress)
        return memo.promise
      }
      const listeners = new Set([onProgress])
      const promise = extract(listeners)
      const mine = { promise, listeners }
      memo = mine
      // Listeners are only wanted until the read ends. A failed read must not
      // stick, so the next ask tries again.
      promise.then(
        () => listeners.clear(),
        () => {
          listeners.clear()
          if (memo === mine) memo = null
        }
      )
      return promise
    },
    getCurrentPage: () => src.getCurrentPage(),
    async whenReady(wait) {
      const end = Date.now() + wait
      for (;;) {
        if (disposed || src.getFailure()) return null
        const doc = src.getDocument()
        if (doc && src.hasIndex()) return { pageCount: doc.pageCount }
        if (Date.now() >= end) return null
        await new Promise((r) => setTimeout(r, pollMs))
      }
    },
    getPageText: (page0) => src.getPageText(page0),
    reveal: (page0, start, end) => src.reveal?.(page0, start, end),
    dispose() {
      disposed = true
    }
  }
}
