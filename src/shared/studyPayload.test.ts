import { describe, expect, it } from 'vitest'
import { sanitizeStudyAttachment, sanitizeStudyMessages } from './studyPayload'

describe('sanitizeStudyAttachment', () => {
  it('keeps only the text fields and drops extras', () => {
    expect(sanitizeStudyAttachment({ kind: 'text', quote: 'q', context: 'c', evil: 1, page: 3 })).toEqual({
      kind: 'text',
      quote: 'q',
      context: 'c'
    })
  })
  it('rejects other kinds, empty quotes and non-objects', () => {
    expect(sanitizeStudyAttachment({ kind: 'region', quote: 'q' })).toBeNull()
    expect(sanitizeStudyAttachment({ kind: 'text', quote: '  ' })).toBeNull()
    expect(sanitizeStudyAttachment({ kind: 'text', quote: 5 })).toBeNull()
    expect(sanitizeStudyAttachment('x')).toBeNull()
    expect(sanitizeStudyAttachment(null)).toBeNull()
  })
  it('caps string length', () => {
    const a = sanitizeStudyAttachment({ kind: 'text', quote: 'a'.repeat(50_000) })
    expect(a && a.kind === 'text' && a.quote.length).toBe(10_000)
  })
})

describe('sanitizeStudyMessages', () => {
  const ok = { id: 'a', role: 'user', text: 'Explain', createdAt: 't', attachments: [{ kind: 'text', quote: 'q' }] }
  it('accepts a well-formed pair', () => {
    const out = sanitizeStudyMessages([ok, { id: 'b', role: 'model', text: 'ans', createdAt: 't' }])
    expect(out).toHaveLength(2)
    expect(out?.[0].attachments).toEqual([{ kind: 'text', quote: 'q' }])
  })
  it('rejects bad roles, shapes and sizes', () => {
    expect(sanitizeStudyMessages([{ ...ok, role: 'system' }])).toBeNull()
    expect(sanitizeStudyMessages([{ ...ok, id: 5 }])).toBeNull()
    expect(sanitizeStudyMessages([])).toBeNull()
    expect(sanitizeStudyMessages('x')).toBeNull()
    expect(sanitizeStudyMessages([ok, ok, ok, ok, ok])).toBeNull()
  })
  it('drops non-text attachments', () => {
    const out = sanitizeStudyMessages([{ ...ok, attachments: [{ kind: 'region', label: 'x' }] }])
    expect(out?.[0].attachments).toBeUndefined()
  })
})
