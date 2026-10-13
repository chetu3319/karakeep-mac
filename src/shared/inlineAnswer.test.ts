import { describe, expect, it } from 'vitest'
import { buildContinueMessages, inlineQuestionText, textAttachment } from './inlineAnswer'

describe('inline answer -> Study', () => {
  it('labels the quick modes and uses the typed question for Ask', () => {
    expect(inlineQuestionText('micro-explain')).toBe('Explain')
    expect(inlineQuestionText('micro-define')).toBe('Define')
    expect(inlineQuestionText('micro-formula')).toBe('Math')
    expect(inlineQuestionText('custom', '  why sqrt(d)?  ')).toBe('why sqrt(d)?')
  })

  it('builds a text attachment and omits empty optional fields', () => {
    expect(textAttachment('q')).toEqual({ kind: 'text', quote: 'q' })
    expect(textAttachment('q', 4, 'ctx')).toEqual({ kind: 'text', quote: 'q', page: 4, context: 'ctx' })
  })

  it('seeds a user turn with the attachment then the model answer', () => {
    let n = 0
    const att = textAttachment('softmax', 4)
    const [u, m] = buildContinueMessages({
      mode: 'micro-formula',
      answer: 'It normalises.',
      attachment: att,
      now: new Date('2026-01-01T00:00:00Z'),
      newId: () => `id${++n}`
    })
    expect(u).toEqual({ id: 'id1', role: 'user', text: 'Math', attachments: [att], createdAt: '2026-01-01T00:00:00.000Z' })
    expect(m).toEqual({ id: 'id2', role: 'model', text: 'It normalises.', createdAt: '2026-01-01T00:00:00.000Z' })
  })
})
