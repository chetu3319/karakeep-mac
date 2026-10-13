import { describe, expect, it } from 'vitest'
import { parseRefs, refLabel } from './aiRefs'

describe('parseRefs', () => {
  it('splits text and a reference', () => {
    const segs = parseRefs('A [[ref p=4 "the dot products grow"]] B')
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ type: 'text', text: 'A ' })
    expect(segs[1]).toEqual({
      type: 'ref',
      ref: { index: 0, quote: 'the dot products grow', page: 4, figure: false }
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

describe('refLabel', () => {
  it('labels pages, figures and unpaged refs', () => {
    expect(refLabel({ index: 0, quote: 'q', page: 4, figure: false }, true)).toBe('p.4')
    expect(refLabel({ index: 0, quote: 'q', page: 4, figure: true }, true)).toBe('Fig. · p.4')
    expect(refLabel({ index: 1, quote: 'q', figure: false }, false)).toBe('2')
  })
})
