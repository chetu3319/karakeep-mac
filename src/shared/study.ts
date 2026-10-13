/**
 * Study: the whole-document AI panel. These are the types and constants every
 * process shares (main saves/syncs the chat, the renderer shows it), so this
 * file stays free of DOM and Node APIs.
 */

/** The one attachment name Study uses on a bookmark, so it can be found again. */
export const STUDY_FILE_NAME = 'karakeep-desktop-study.html'

/** Bumped only when the persisted shape changes incompatibly. */
export const STUDY_SCHEMA_VERSION = 1

/** Most characters of document text sent to the model in one request. */
export const STUDY_BUDGET_CHARS = 400_000

export interface StudyRect {
  x: number
  y: number
  width: number
  height: number
}

export type StudyAttachment =
  | { kind: 'text'; quote: string; page?: number; context?: string }
  | {
      kind: 'region'
      label: string
      page?: number
      rect: StudyRect
      text?: string
      /** Sent to the model but never persisted: it would bloat the saved file. */
      imageDataUrl?: string
    }

export interface StudyMessage {
  id: string
  role: 'user' | 'model'
  text: string
  attachments?: StudyAttachment[]
  createdAt: string
}

export interface StudyThread {
  v: number
  bookmarkId: string
  updatedAt: string
  messages: StudyMessage[]
}

export function isStudyAsset(asset: { fileName?: string | null }): boolean {
  return asset.fileName === STUDY_FILE_NAME
}

/** A copy of the thread that is safe to write to disk or upload. */
export function stripForPersistence(thread: StudyThread): StudyThread {
  return {
    ...thread,
    messages: thread.messages.map((m) => {
      if (!m.attachments) return m
      return {
        ...m,
        attachments: m.attachments.map((a) => {
          if (a.kind !== 'region') return a
          const { imageDataUrl: _drop, ...rest } = a
          return rest
        })
      }
    })
  }
}
