import { describe, expect, it } from 'vitest'
import { parseRefs, refDetail, refLabel } from './aiRefs'

describe('parseRefs', () => {
  it('splits text and a reference', () => {
    const segs = parseRefs('A [[ref p=4 "the dot products grow"]] B')
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ type: 'text', text: 'A ' })
    expect(segs[1]).toEqual({
      type: 'ref',
      ref: { index: 0, number: 1, quote: 'the dot products grow', page: 4, figure: false }
    })
    expect(segs[2]).toEqual({ type: 'text', text: ' B' })
  })

  it('marks figures', () => {
    const segs = parseRefs('[[ref fig p=2 "Figure 1 shows"]]')
    expect(segs[0]).toMatchObject({ type: 'ref', ref: { figure: true, page: 2 } })
  })

  it('allows a missing page', () => {
    const segs = parseRefs('[[ref "web quote"]]')
    expect(segs[0]).toMatchObject({ type: 'ref', ref: { page: undefined, quote: 'web quote' } })
  })

  it('indexes refs in order', () => {
    const refs = parseRefs('[[ref p=1 "a"]] and [[ref p=2 "b"]]').filter((s) => s.type === 'ref')
    expect(refs.map((s) => (s as { ref: { index: number } }).ref.index)).toEqual([0, 1])
  })

  it('hides an unfinished marker while streaming', () => {
    expect(parseRefs('text [[ref p=4 "unfini', { streaming: true })).toEqual([
      { type: 'text', text: 'text ' }
    ])
  })

  it('hides a partial marker opener while streaming', () => {
    expect(parseRefs('text [[re', { streaming: true })).toEqual([{ type: 'text', text: 'text ' }])
    expect(parseRefs('text [', { streaming: true })).toEqual([{ type: 'text', text: 'text ' }])
  })

  it('drops an unclosed marker when not streaming', () => {
    expect(parseRefs('text [[ref p=4 "unfini')).toEqual([{ type: 'text', text: 'text ' }])
  })

  it('removes a malformed closed marker', () => {
    expect(parseRefs('a [[ref nonsense]] b')).toEqual([{ type: 'text', text: 'a  b' }])
  })

  it('never throws or leaks raw markers', () => {
    for (const s of ['[[ref', '[[ref ]]', ']] [[', '[[ref p=x "q"]]', '[[ref "q']) {
      for (const streaming of [true, false]) {
        const out = parseRefs(s, { streaming })
        expect(JSON.stringify(out)).not.toContain('[[ref')
      }
    }
  })
})

describe('numbering', () => {
  it('numbers refs in order and shares a number between identical refs', () => {
    const refs = parseRefs(
      '[[ref p=1 "Alpha beta."]] [[ref p=2 "Gamma."]] [[ref p=1 "alpha   beta."]] [[ref p=3 "Alpha beta."]]'
    )
      .filter((s) => s.type === 'ref')
      .map((s) => (s as { ref: { number: number } }).ref.number)
    expect(refs).toEqual([1, 2, 1, 3])
  })
})

describe('refLabel', () => {
  const r = (number: number, page?: number, figure = false) => ({ index: 0, number, quote: 'q', page, figure })
  it('is the number for PDF, figure and web refs', () => {
    expect(refLabel(r(2, 4))).toBe('2')
    expect(refLabel(r(3, 4, true))).toBe('3')
    expect(refLabel(r(5))).toBe('5')
  })
  it('details carry the page only when there is one', () => {
    expect(refDetail(r(1, 4))).toBe('p.4 — "q"')
    expect(refDetail(r(1))).toBe('"q"')
  })
})
