/**
 * Keeps a Study chat in two places: the local store (written on every save)
 * and an HTML file attached to the Karakeep bookmark (pushed after a quiet
 * period). The attachment is a backup and a way to resume on another
 * machine; it is never required for the chat to work.
 */
import type { KarakeepApiClient } from './api'
import type { createStudyStore } from './studyStore'
import { STUDY_FILE_NAME, isStudyAsset, type StudyThread, type SyncState } from '../shared/study'
import { parseStudyHtml, renderStudyHtml } from '../shared/studyFile'

export type { SyncState }

export interface StudySyncDeps {
  api: Pick<
    KarakeepApiClient,
    'getBookmark' | 'uploadAsset' | 'attachAssetToBookmark' | 'detachAssetFromBookmark' | 'getAssetText'
  >
  store: ReturnType<typeof createStudyStore>
  debounceMs: number
  onState: (bookmarkId: string, state: SyncState) => void
}

export function createStudySync(deps: StudySyncDeps): {
  open(bookmarkId: string): Promise<StudyThread | null>
  save(thread: StudyThread, docTitle: string): Promise<void>
  flush(bookmarkId: string): Promise<void>
  clear(bookmarkId: string): Promise<void>
} {
  const { api, store, debounceMs, onState } = deps
  const pulled = new Set<string>()
  // A remote file written by a newer version of the app: never overwrite it.
  const blocked = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const titles = new Map<string, string>()
  // Bookmarks whose latest local save has not reached Karakeep yet.
  const dirty = new Set<string>()
  const running = new Map<string, Promise<void>>()

  function cancelTimer(bookmarkId: string): void {
    const t = timers.get(bookmarkId)
    if (t) clearTimeout(t)
    timers.delete(bookmarkId)
  }

  async function studyAssets(bookmarkId: string): Promise<string[]> {
    const bookmark = await api.getBookmark(bookmarkId)
    return bookmark.assets.filter(isStudyAsset).map((a) => a.id)
  }

  async function pushOnce(bookmarkId: string): Promise<void> {
    if (blocked.has(bookmarkId) || !dirty.has(bookmarkId)) return
    const thread = await store.load(bookmarkId)
    if (!thread) {
      dirty.delete(bookmarkId)
      return
    }
    try {
      // Upload, attach, and only then detach the older files: if any step
      // fails the previous backup is still there, and the next save retries.
      const older = await studyAssets(bookmarkId)
      const html = renderStudyHtml(thread, titles.get(bookmarkId) ?? '')
      const data = new TextEncoder().encode(html)
      const uploaded = await api.uploadAsset({
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        mimeType: 'text/html',
        fileName: STUDY_FILE_NAME
      })
      await api.attachAssetToBookmark(bookmarkId, uploaded.assetId)
      for (const id of older) await api.detachAssetFromBookmark(bookmarkId, id)
      // Only forget the pending push if nothing newer was saved meanwhile.
      const latest = await store.load(bookmarkId)
      if (latest && latest.updatedAt === thread.updatedAt) dirty.delete(bookmarkId)
      onState(bookmarkId, dirty.has(bookmarkId) ? 'pending' : 'saved')
    } catch (err) {
      console.error('[study] sync failed', err instanceof Error ? err.message : String(err))
      onState(bookmarkId, 'failed')
    }
  }

  // Pushes for one bookmark never overlap.
  function push(bookmarkId: string): Promise<void> {
    const prev = running.get(bookmarkId) ?? Promise.resolve()
    const next = prev.then(() => pushOnce(bookmarkId))
    running.set(bookmarkId, next)
    return next
  }

  return {
    async open(bookmarkId) {
      const local = await store.load(bookmarkId)
      if (pulled.has(bookmarkId)) return local
      try {
        const ids = await studyAssets(bookmarkId)
        pulled.add(bookmarkId)
        if (ids.length === 0) return local
        const parsed = parseStudyHtml(await api.getAssetText(ids[ids.length - 1]))
        if (parsed.status === 'newer') {
          blocked.add(bookmarkId)
          onState(bookmarkId, 'newer-version')
          return local
        }
        if (parsed.status === 'invalid') return local
        if (!local || Date.parse(parsed.thread.updatedAt) > Date.parse(local.updatedAt)) {
          await store.save(parsed.thread)
          return parsed.thread
        }
        return local
      } catch {
        // Karakeep unreachable: the local copy is all we have, and a later
        // open may still pull.
        return local
      }
    },

    async save(thread, docTitle) {
      const id = thread.bookmarkId
      titles.set(id, docTitle)
      await store.save(thread)
      if (blocked.has(id)) {
        onState(id, 'newer-version')
        return
      }
      dirty.add(id)
      onState(id, 'pending')
      cancelTimer(id)
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          void push(id)
        }, debounceMs)
      )
    },

    async flush(bookmarkId) {
      cancelTimer(bookmarkId)
      await push(bookmarkId)
    },

    async clear(bookmarkId) {
      cancelTimer(bookmarkId)
      dirty.delete(bookmarkId)
      titles.delete(bookmarkId)
      await running.get(bookmarkId)
      await store.remove(bookmarkId)
      try {
        for (const id of await studyAssets(bookmarkId)) await api.detachAssetFromBookmark(bookmarkId, id)
        onState(bookmarkId, 'idle')
      } catch (err) {
        console.error('[study] could not remove the Karakeep copy', err instanceof Error ? err.message : String(err))
        onState(bookmarkId, 'failed')
      }
    }
  }
}
