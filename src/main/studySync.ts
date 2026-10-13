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
  /** Pushes every chat with unsynced changes now (used on quit). */
  flushAll(): Promise<void>
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
  // Remote Study files confirmed to parse as ours-or-older. Only these are
  // ever detached: a file we could not read may be someone else's data.
  const verified = new Map<string, Set<string>>()

  function cancelTimer(bookmarkId: string): void {
    const t = timers.get(bookmarkId)
    if (t) clearTimeout(t)
    timers.delete(bookmarkId)
  }

  async function studyAssets(bookmarkId: string): Promise<string[]> {
    const bookmark = await api.getBookmark(bookmarkId)
    return bookmark.assets.filter(isStudyAsset).map((a) => a.id)
  }

  /**
   * Reads the remote Study files once per bookmark. Throws when Karakeep
   * cannot be read (so nothing is marked pulled and a later call retries).
   * Returns the newest readable remote thread, or null.
   */
  async function pull(bookmarkId: string): Promise<StudyThread | null> {
    const ids = await studyAssets(bookmarkId)
    let best: StudyThread | null = null
    const ok = new Set<string>()
    for (const id of ids) {
      const parsed = parseStudyHtml(await api.getAssetText(id))
      if (parsed.status === 'newer') blocked.add(bookmarkId)
      else if (parsed.status === 'ok') {
        ok.add(id)
        if (!best || Date.parse(parsed.thread.updatedAt) > Date.parse(best.updatedAt)) best = parsed.thread
      }
    }
    verified.set(bookmarkId, ok)
    pulled.add(bookmarkId)
    if (blocked.has(bookmarkId)) onState(bookmarkId, 'newer-version')
    return best
  }

  function schedule(id: string): void {
    cancelTimer(id)
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        void push(id)
      }, debounceMs)
    )
  }

  async function pushOnce(bookmarkId: string): Promise<void> {
    if (blocked.has(bookmarkId) || !dirty.has(bookmarkId)) return
    const thread = await store.load(bookmarkId)
    if (!thread) {
      dirty.delete(bookmarkId)
      return
    }
    try {
      // Never push over a remote we have not looked at: it may be written by
      // a newer version of the app.
      if (!pulled.has(bookmarkId)) await pull(bookmarkId)
      if (blocked.has(bookmarkId)) return
      // Upload, attach, and only then detach the older files: if any step
      // fails the previous backup is still there, and the next save retries.
      const older = (await studyAssets(bookmarkId)).filter((id) => verified.get(bookmarkId)?.has(id))
      const html = renderStudyHtml(thread, titles.get(bookmarkId) ?? '')
      const data = new TextEncoder().encode(html)
      const uploaded = await api.uploadAsset({
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        mimeType: 'text/html',
        fileName: STUDY_FILE_NAME
      })
      try {
        await api.attachAssetToBookmark(bookmarkId, uploaded.assetId)
      } catch (err) {
        // Karakeep has no call that deletes an asset that was never attached
        // (detaching is what deletes it), so an upload orphaned here cannot
        // be removed for certain. If the attach did land and only its reply
        // was lost, detaching clears it; otherwise this is a harmless no-op.
        await api.detachAssetFromBookmark(bookmarkId, uploaded.assetId).catch(() => {})
        throw err
      }
      verified.get(bookmarkId)?.add(uploaded.assetId)
      for (const id of older) {
        await api.detachAssetFromBookmark(bookmarkId, id)
        verified.get(bookmarkId)?.delete(id)
      }
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
        const remote = await pull(bookmarkId)
        if (blocked.has(bookmarkId)) return local
        if (remote && (!local || Date.parse(remote.updatedAt) > Date.parse(local.updatedAt))) {
          // The file is trusted for its content, not for which bookmark it
          // claims: it is saved under (and returned for) the one asked for.
          const adopted = { ...remote, bookmarkId }
          await store.save(adopted)
          return adopted
        }
        // The local chat is ahead of (or missing from) Karakeep, e.g. the app
        // quit before the last push: back it up now.
        if (local && (!remote || Date.parse(local.updatedAt) > Date.parse(remote.updatedAt))) {
          dirty.add(bookmarkId)
          onState(bookmarkId, 'pending')
          schedule(bookmarkId)
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
      schedule(id)
    },

    async flush(bookmarkId) {
      cancelTimer(bookmarkId)
      await push(bookmarkId)
    },

    async flushAll() {
      await Promise.all([...dirty].map((id) => this.flush(id)))
    },

    async clear(bookmarkId) {
      cancelTimer(bookmarkId)
      pulled.delete(bookmarkId)
      blocked.delete(bookmarkId)
      verified.delete(bookmarkId)
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
