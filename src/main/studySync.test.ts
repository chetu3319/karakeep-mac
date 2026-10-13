import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderStudyHtml } from '../shared/studyFile'
import { STUDY_FILE_NAME, STUDY_SCHEMA_VERSION, type StudyThread } from '../shared/study'
import { createStudyStore } from './studyStore'
import { createStudySync, type SyncState } from './studySync'

function thread(updatedAt: string, text = 'hi', v = STUDY_SCHEMA_VERSION): StudyThread {
  return {
    v,
    bookmarkId: 'b1',
    updatedAt,
    messages: [{ id: 'm1', role: 'user', text, createdAt: updatedAt }]
  }
}

function fakeApi(opts: { remote?: string; oldAssets?: string[] } = {}) {
  const calls: string[] = []
  const api = {
    getBookmark: vi.fn(async () => ({
      assets: (opts.oldAssets ?? []).map((id) => ({ id, assetType: 'userUploaded', fileName: STUDY_FILE_NAME })),
      id: 'b1'
    })),
    uploadAsset: vi.fn(async () => {
      calls.push('upload')
      return { assetId: 'new', contentType: 'text/html', size: 1, fileName: STUDY_FILE_NAME }
    }),
    attachAssetToBookmark: vi.fn(async () => {
      calls.push('attach')
    }),
    detachAssetFromBookmark: vi.fn(async (_b: string, a: string) => {
      calls.push(`detach:${a}`)
    }),
    getAssetText: vi.fn(async () => opts.remote ?? '')
  }
  return { api, calls }
}

describe('studySync', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'study-'))
    vi.useFakeTimers()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  })

  function make(f: ReturnType<typeof fakeApi>) {
    const states: SyncState[] = []
    const store = createStudyStore(dir)
    const sync = createStudySync({
      api: f.api as never,
      store,
      debounceMs: 1000,
      onState: (_id, s) => states.push(s)
    })
    return { sync, store, states }
  }

  it('saves locally now and pushes once after the debounce', async () => {
    const f = fakeApi()
    const { sync, store, states } = make(f)
    await sync.save(thread('2026-01-01T00:00:00Z', 'a'), 'Doc')
    await sync.save(thread('2026-01-01T00:00:01Z', 'b'), 'Doc')
    await sync.save(thread('2026-01-01T00:00:02Z', 'c'), 'Doc')
    expect((await store.load('b1'))?.messages[0].text).toBe('c')
    expect(f.api.uploadAsset).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    // the push does real file I/O, so wait for it rather than for timers
    await vi.waitFor(() => expect(states.at(-1)).toBe('saved'))
    expect(f.api.uploadAsset).toHaveBeenCalledTimes(1)
    expect(states).toContain('pending')
  })

  it('pushes upload, attach, then detach of the old asset', async () => {
    const f = fakeApi({ oldAssets: ['old'] })
    const { sync } = make(f)
    await sync.save(thread('2026-01-01T00:00:00Z'), 'Doc')
    await sync.flush('b1')
    expect(f.calls).toEqual(['upload', 'attach', 'detach:old'])
  })

  it('on attach failure sets failed, detaches nothing and keeps the local file', async () => {
    const f = fakeApi({ oldAssets: ['old'] })
    f.api.attachAssetToBookmark.mockRejectedValueOnce(new Error('down'))
    const { sync, store, states } = make(f)
    await sync.save(thread('2026-01-01T00:00:00Z'), 'Doc')
    await sync.flush('b1')
    expect(states.at(-1)).toBe('failed')
    expect(f.api.detachAssetFromBookmark).not.toHaveBeenCalled()
    expect(await store.load('b1')).not.toBeNull()
    // the next flush retries
    await sync.flush('b1')
    expect(states.at(-1)).toBe('saved')
  })

  it('open returns the remote thread when it is newer', async () => {
    const remote = thread('2026-02-01T00:00:00Z', 'remote')
    const f = fakeApi({ remote: renderStudyHtml(remote, 'Doc'), oldAssets: ['old'] })
    const { sync, store } = make(f)
    await store.save(thread('2026-01-01T00:00:00Z', 'local'))
    const got = await sync.open('b1')
    expect(got?.messages[0].text).toBe('remote')
  })

  it('open keeps local, flags newer-version and blocks pushes for a v2 remote', async () => {
    const f = fakeApi({ remote: renderStudyHtml(thread('2027-01-01T00:00:00Z', 'r', 2), 'Doc'), oldAssets: ['old'] })
    const { sync, store, states } = make(f)
    await store.save(thread('2026-01-01T00:00:00Z', 'local'))
    const got = await sync.open('b1')
    expect(got?.messages[0].text).toBe('local')
    expect(states).toContain('newer-version')
    await sync.save(thread('2026-01-02T00:00:00Z', 'x'), 'Doc')
    await sync.flush('b1')
    expect(f.api.uploadAsset).not.toHaveBeenCalled()
  })

  it('pulls at most once per bookmark', async () => {
    const f = fakeApi({ remote: renderStudyHtml(thread('2026-02-01T00:00:00Z'), 'Doc'), oldAssets: ['old'] })
    const { sync } = make(f)
    await sync.open('b1')
    await sync.open('b1')
    expect(f.api.getAssetText).toHaveBeenCalledTimes(1)
  })

  it('ignores a malformed remote file', async () => {
    const f = fakeApi({ remote: '<html>garbage</html>', oldAssets: ['old'] })
    const { sync, store } = make(f)
    await store.save(thread('2026-01-01T00:00:00Z', 'local'))
    const got = await sync.open('b1')
    expect(got?.messages[0].text).toBe('local')
  })

  it('clear removes the local copy and detaches remote study files', async () => {
    const f = fakeApi({ oldAssets: ['o1', 'o2'] })
    const { sync, store } = make(f)
    await sync.save(thread('2026-01-01T00:00:00Z'), 'Doc')
    await sync.clear('b1')
    expect(await store.load('b1')).toBeNull()
    expect(f.calls).toEqual(['detach:o1', 'detach:o2'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.api.uploadAsset).not.toHaveBeenCalled()
  })
})
