import { describe, expect, it } from 'vitest'
import { locateQuote } from './pdfAnchor'

describe('locateQuote', () => {
  it('prefers an exact case-sensitive match over an earlier case-insensitive one', () => {
    const text = 'the cat sat. The Cat sat.'
    expect(locateQuote(text, 'The Cat')).toEqual({ start: 13, end: 20 })
  })

  it('reports the matched span, not the quote length, across a hyphenated line break', () => {
    const text = 'pay close atten-\ntion to this'
    const hit = locateQuote(text, 'close attention')!
    expect(text.slice(hit.start, hit.end)).toBe('close atten-\ntion')
    expect(hit.end - hit.start).toBeGreaterThan('close attention'.length)
  })

  it('returns null when absent', () => {
    expect(locateQuote('abc', 'xyz')).toBeNull()
  })
})
