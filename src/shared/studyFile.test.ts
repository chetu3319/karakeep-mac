import { describe, expect, it } from 'vitest'
import { isStudyAsset, stripForPersistence, type StudyThread } from './study'
import { parseStudyHtml, renderStudyHtml } from './studyFile'

const thread = (over: Partial<StudyThread> = {}): StudyThread => ({
  v: 1,
  bookmarkId: 'b1',
  updatedAt: '2026-10-12T10:00:00.000Z',
  messages: [
    {
      id: 'm1',
      role: 'user',
      text: 'What is attention?',
      createdAt: '2026-10-12T10:00:00.000Z',
      attachments: [
        { kind: 'text', quote: 'attention is all', page: 3, context: 'ctx' },
        {
          kind: 'region',
          label: 'Figure 2',
          page: 4,
          rect: { x: 1, y: 2, width: 3, height: 4 },
          imageDataUrl: 'data:image/png;base64,AAAA'
        }
      ]
    },
    {
      id: 'm2',
      role: 'model',
      text: 'It weighs tokens [[ref p=3 "attention is all"]].',
      createdAt: '2026-10-12T10:00:05.000Z'
    }
  ],
  ...over
})

describe('study file', () => {
  it('round-trips and strips image data', () => {
    const t = thread()
    const parsed = parseStudyHtml(renderStudyHtml(t, 'Paper'))
    expect(parsed).toEqual({ status: 'ok', thread: stripForPersistence(t) })
    expect(JSON.stringify(parsed)).not.toContain('imageDataUrl')
  })

  it('escapes hostile message text', () => {
    const text = '</script><script>alert(1)</script> & <b>'
    const t = thread({ messages: [{ id: 'm', role: 'model', text, createdAt: 'x' }] })
    const html = renderStudyHtml(t, '<i>Title</i>')
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<i>Title</i>')
    const parsed = parseStudyHtml(html)
    expect(parsed.status).toBe('ok')
    if (parsed.status === 'ok') expect(parsed.thread.messages[0].text).toBe(text)
  })

  it('reports newer schema versions', () => {
    expect(parseStudyHtml(renderStudyHtml(thread({ v: 2 }), 'T'))).toEqual({ status: 'newer', v: 2 })
  })

  it('rejects garbage', () => {
    expect(parseStudyHtml('<html>nope</html>')).toEqual({ status: 'invalid' })
    expect(parseStudyHtml('')).toEqual({ status: 'invalid' })
    expect(
      parseStudyHtml('<script type="application/json" id="kk-study">{bad</script>')
    ).toEqual({ status: 'invalid' })
    expect(
      parseStudyHtml('<script type="application/json" id="kk-study">{"v":1,"messages":5}</script>')
    ).toEqual({ status: 'invalid' })
  })

  it('shows references readably in the transcript', () => {
    const html = renderStudyHtml(thread(), 'Paper')
    expect(html).toContain('“attention is all” (p.3)')
    // The JSON block keeps the raw marker; only the readable part must not.
    expect(html.replace(/<script[\s\S]*<\/script>/, '')).not.toContain('[[ref')
  })
})

describe('isStudyAsset', () => {
  it('recognises only the study file', () => {
    expect(isStudyAsset({ fileName: 'karakeep-desktop-study.html' })).toBe(true)
    expect(isStudyAsset({ fileName: 'paper.pdf' })).toBe(false)
    expect(isStudyAsset({ fileName: null })).toBe(false)
    expect(isStudyAsset({})).toBe(false)
  })
})
