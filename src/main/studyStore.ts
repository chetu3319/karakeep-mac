/**
 * Local copy of each Study chat, one JSON file per bookmark under the app's
 * userData. The local file is the source of truth while the app is running;
 * the Karakeep attachment (studySync.ts) is only a backup that lets another
 * machine pick the chat up.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripForPersistence, type StudyThread } from '../shared/study'

export function createStudyStore(dir: string): {
  load(bookmarkId: string): Promise<StudyThread | null>
  save(thread: StudyThread): Promise<void>
  remove(bookmarkId: string): Promise<void>
} {
  // Bookmark ids are server-issued, but they end up in a file name, so keep
  // anything path-like out of it.
  const fileFor = (bookmarkId: string): string => join(dir, `${bookmarkId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

  return {
    async load(bookmarkId) {
      try {
        const parsed = JSON.parse(await readFile(fileFor(bookmarkId), 'utf8')) as StudyThread
        return parsed && Array.isArray(parsed.messages) ? parsed : null
      } catch {
        return null
      }
    },
    async save(thread) {
      await mkdir(dir, { recursive: true })
      const file = fileFor(thread.bookmarkId)
      // Write beside the target then rename, so a crash mid-write can never
      // leave a half-written chat in place of a good one.
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(stripForPersistence(thread)), 'utf8')
      await rename(tmp, file)
    },
    async remove(bookmarkId) {
      await rm(fileFor(bookmarkId), { force: true })
    }
  }
}
