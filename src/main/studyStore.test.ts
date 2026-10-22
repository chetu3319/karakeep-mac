import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STUDY_SCHEMA_VERSION, type StudyThread } from '../shared/study'
import { createStudyStore } from './studyStore'

const thread = (n: number, pad: number): StudyThread => ({
  v: STUDY_SCHEMA_VERSION,
  bookmarkId: 'b1',
  updatedAt: new Date(2026, 0, 1, 0, 0, n).toISOString(),
  messages: [{ id: 'm', role: 'user', text: `v${n}${'x'.repeat(pad)}`, createdAt: '2026-01-01T00:00:00.000Z' }]
})

describe('studyStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'study-store-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('the last save wins when saves overlap', async () => {
    const store = createStudyStore(dir)
    // The first write is by far the largest, so unserialised it would finish last.
    const saves = [store.save(thread(1, 2_000_000)), store.save(thread(2, 100_000)), store.save(thread(3, 0))]
    await Promise.all(saves)
    expect((await store.load('b1'))?.messages[0].text).toBe('v3')
  })

  it('a failed save does not block the next one', async () => {
    const store = createStudyStore(dir)
    await rm(dir, { recursive: true, force: true })
    await store.save(thread(1, 0)) // recreates the directory
    await store.save(thread(2, 0))
    expect((await store.load('b1'))?.messages[0].text).toBe('v2')
  })
})
