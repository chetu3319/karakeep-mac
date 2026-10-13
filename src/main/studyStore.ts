/**
 * Local copy of each Study chat, one JSON file per bookmark under the app's
 * userData. The local file is the source of truth while the app is running;
 * the Karakeep attachment (studySync.ts) is only a backup that lets another
 * machine pick the chat up.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripForPersistence, type StudyThread } from '../shared/study'

let tmpCounter = 0

/** Saves of one chat run one after another, so an older write can never rename over a newer one. */
const saving = new Map<string, Promise<void>>()

export function createStudyStore(dir: string): {
  load(bookmarkId: string): Promise<StudyThread | null>
  save(thread: StudyThread): Promise<void>
  remove(bookmarkId: string): Promise<void>
} {
  // Bookmark ids are server-issued, but they end up in a file name, so keep
  // anything path-like out of it.
  const fileFor = (bookmarkId: string): string => join(dir, `${bookmarkId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)

  async function write(thread: StudyThread): Promise<void> {
    await mkdir(dir, { recursive: true })
    const file = fileFor(thread.bookmarkId)
    // Write beside the target then rename, so a crash mid-write can never
    // leave a half-written chat in place of a good one.
    // The name is unique per write so overlapping saves of one chat cannot
    // rename each other's file out from under them.
    const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(stripForPersistence(thread)), 'utf8')
      await rename(tmp, file)
    } catch (err) {
      await rm(tmp, { force: true })
      throw err
    }
  }

  return {
    async load(bookmarkId) {
      try {
        const parsed = JSON.parse(await readFile(fileFor(bookmarkId), 'utf8')) as StudyThread
        return parsed && Array.isArray(parsed.messages) ? parsed : null
      } catch {
        return null
      }
    },
    save(thread) {
      const key = fileFor(thread.bookmarkId)
      const run = (saving.get(key) ?? Promise.resolve()).then(() => write(thread))
      const tail = run.catch(() => {})
      saving.set(key, tail)
      void tail.then(() => {
        if (saving.get(key) === tail) saving.delete(key)
      })
      return run
    },
    async remove(bookmarkId) {
      await (saving.get(fileFor(bookmarkId)) ?? Promise.resolve())
      await rm(fileFor(bookmarkId), { force: true })
    }
  }
}
