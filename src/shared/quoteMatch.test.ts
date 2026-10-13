import { describe, expect, it } from 'vitest'
import { findQuote } from './quoteMatch'

describe('findQuote', () => {
  it('finds an exact match', () => {
    expect(findQuote('hello big world', 'big')).toEqual({ start: 6, end: 9 })
  })

  it('tolerates newlines and repeated spaces in the haystack', () => {
    const hay = 'the dot\n  products   grow'
    const hit = findQuote(hay, 'dot products grow')
    expect(hit).not.toBeNull()
    expect(hay.slice(hit!.start, hit!.end)).toBe('dot\n  products   grow')
  })

  it('joins a word broken by a hyphen at a line break', () => {
    const hay = 'pay atten-\ntion to this'
    const hit = findQuote(hay, 'attention to')
    expect(hit).not.toBeNull()
    expect(hay.slice(hit!.start, hit!.end)).toBe('atten-\ntion to')
  })

  it('expands ligatures', () => {
    const hay = 'the ﬁnal answer'
    const hit = findQuote(hay, 'final answer')
    expect(hit).not.toBeNull()
    expect(hay.slice(hit!.start, hit!.end)).toBe('ﬁnal answer')
  })

  it('matches curly quotes against straight ones', () => {
    const hay = 'he said “x” twice'
    const hit = findQuote(hay, '"x"')
    expect(hit).not.toBeNull()
    expect(hay.slice(hit!.start, hit!.end)).toBe('“x”')
  })

  it('is case-insensitive', () => {
    expect(findQuote('Some LOUD Text', 'loud text')).toEqual({ start: 5, end: 14 })
  })

  it('returns original offsets', () => {
    const hay = 'aaa\n\nbbb  ccc ddd'
    const hit = findQuote(hay, 'bbb ccc')
    expect(hay.slice(hit!.start, hit!.end)).toBe('bbb  ccc')
  })

  it('returns null when absent', () => {
    expect(findQuote('hello world', 'xyz')).toBeNull()
  })

  it('returns null for an empty quote', () => {
    expect(findQuote('hello', '')).toBeNull()
    expect(findQuote('hello', '  \n ')).toBeNull()
  })
})
