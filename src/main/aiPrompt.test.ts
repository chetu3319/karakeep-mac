import { describe, expect, it } from 'vitest'
import { MAX_TOTAL_IMAGE_CHARS, buildPromptPayload } from './aiPrompt'
import type { AiStreamRequest } from '../shared/types'
import type { StudyMessage } from '../shared/study'

const base: AiStreamRequest = {
  requestId: 'r1',
  mode: 'study',
  docTitle: 'A Paper',
  sourceUrl: 'https://example.com/a.pdf',
  documentText: 'The quick brown fox jumps over the lazy dog.',
  paged: true
}

function userMsg(id: string, text: string, imageDataUrl?: string): StudyMessage {
  return {
    id,
    role: 'user',
    text,
    createdAt: '2026-01-01T00:00:00Z',
    attachments: imageDataUrl
      ? [
          {
            kind: 'region',
            label: 'Figure 1',
            page: 2,
            rect: { x: 0, y: 0, width: 1, height: 1 },
            imageDataUrl
          }
        ]
      : undefined
  }
}

function inlineParts(contents: ReturnType<typeof buildPromptPayload>['contents']) {
  return contents.map((c) => c.parts.filter((p) => 'inlineData' in p).length)
}

describe('buildPromptPayload study', () => {
  it('puts the document text and the ref grammar in the system instruction', () => {
    const { systemInstruction } = buildPromptPayload({ ...base, studyMessages: [userMsg('1', 'hi')] })
    expect(systemInstruction).toContain('The quick brown fox')
    expect(systemInstruction).toContain('[[ref')
  })

  it('steers citations to the evidence, whole sentences and varied passages', () => {
    const { systemInstruction: si } = buildPromptPayload({ ...base, studyMessages: [userMsg('1', 'hi')] })
    expect(si).toContain('not the abstract or introduction')
    expect(si).toContain('Use the abstract only when')
    expect(si).toContain('complete sentence')
    expect(si).toContain('mid-phrase')
    expect(si).toContain('reader attached a passage')
    expect(si).toContain('different supporting passages')
  })

  it('keeps the system instruction identical across turns', () => {
    const a = buildPromptPayload({ ...base, studyMessages: [userMsg('1', 'hi')], currentPage: 1 })
    const b = buildPromptPayload({
      ...base,
      studyMessages: [userMsg('1', 'hi'), { id: '2', role: 'model', text: 'yo', createdAt: 'x' }, userMsg('3', 'more')],
      currentPage: 5
    })
    expect(a.systemInstruction).toBe(b.systemInstruction)
  })

  it('turns a region image into an inlineData part', () => {
    const { contents } = buildPromptPayload({
      ...base,
      studyMessages: [userMsg('1', 'what is this', 'data:image/png;base64,AAAA')]
    })
    expect(contents[0].parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } })
  })

  it('keeps images only on the last four image turns', () => {
    const msgs: StudyMessage[] = []
    for (let i = 0; i < 6; i++) msgs.push(userMsg(`u${i}`, `q${i}`, 'data:image/png;base64,AAAA'))
    const { contents } = buildPromptPayload({ ...base, studyMessages: msgs })
    expect(inlineParts(contents)).toEqual([0, 0, 1, 1, 1, 1])
    expect(JSON.stringify(contents[0])).toContain('Figure 1')
  })

  it('drops the oldest images first when the total would be too large', () => {
    const big = `data:image/png;base64,${'A'.repeat(Math.floor(MAX_TOTAL_IMAGE_CHARS * 0.4))}`
    const msgs: StudyMessage[] = [0, 1, 2].map((i) => userMsg(`u${i}`, `q${i}`, big))
    const { contents } = buildPromptPayload({ ...base, studyMessages: msgs })
    // three images do not fit; the two newest are within the cap
    expect(inlineParts(contents)).toEqual([0, 1, 1])
  })

  it('adds the reader page to the last user turn only', () => {
    const { contents } = buildPromptPayload({
      ...base,
      currentPage: 7,
      studyMessages: [userMsg('1', 'a'), { id: '2', role: 'model', text: 'b', createdAt: 'x' }, userMsg('3', 'c')]
    })
    expect(JSON.stringify(contents[2])).toContain('Reader is on page 7.')
    expect(JSON.stringify(contents[0])).not.toContain('Reader is on page')
  })

  it('renders text attachments with page and context', () => {
    const { contents } = buildPromptPayload({
      ...base,
      studyMessages: [
        {
          id: '1',
          role: 'user',
          text: 'explain',
          createdAt: 'x',
          attachments: [{ kind: 'text', quote: 'lazy dog', page: 4, context: 'over the lazy dog.' }]
        }
      ]
    })
    const text = JSON.stringify(contents[0])
    expect(text).toContain('Attached passage (p.4): \\"lazy dog\\"')
    expect(text).toContain('over the lazy dog.')
  })
})

describe('buildPromptPayload micro modes', () => {
  it('limits explain to at most 3 sentences', () => {
    const { systemInstruction } = buildPromptPayload({
      requestId: 'r',
      mode: 'micro-explain',
      selectionText: 'foo'
    })
    expect(systemInstruction).toContain('at most 3 sentences')
  })

  it('limits Ask... (custom) to at most 3 sentences and carries the question', () => {
    const { systemInstruction, contents } = buildPromptPayload({
      requestId: 'r',
      mode: 'custom',
      selectionText: 'foo',
      prompt: 'why?'
    })
    expect(systemInstruction).toContain('at most 3 sentences')
    expect(JSON.stringify(contents)).toContain('why?')
  })
})
