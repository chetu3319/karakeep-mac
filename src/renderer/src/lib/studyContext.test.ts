import { describe, expect, it } from 'vitest'
import { assembleDocument, type DocPage } from './studyContext'

const pages = (n: number, size: number): DocPage[] =>
  Array.from({ length: n }, (_, i) => ({ page: i + 1, text: String(i + 1).padStart(2, '0').repeat(size / 2) }))

describe('assembleDocument', () => {
  it('joins pages in order when under budget', () => {
    const out = assembleDocument(
      [
        { page: 1, text: 'one' },
        { page: 2, text: 'two' }
      ],
      { budget: 1000, focusPages: [] }
    )
    expect(out).toBe('[[page 1]]\none\n\n[[page 2]]\ntwo')
  })

  it('trims a long document around the focus', () => {
    const out = assembleDocument(pages(50, 10_000), {
      budget: 100_000,
      focusPages: [35],
      currentPage: 20
    })
    const kept = [...out.matchAll(/\[\[page (\d+)\]\]/g)].map((m) => Number(m[1]))
    expect(kept).toEqual([1, 2, 19, 20, 21, 34, 35, 36, 50])
    expect(out).toContain('[… pages 3–18 omitted …]')
    expect(out).toContain('[… pages 22–33 omitted …]')
    expect(out.length).toBeLessThanOrEqual(100_000)
  })

  it('uses spare budget instead of keeping only the minimum', () => {
    const out = assembleDocument(pages(50, 1_000), {
      budget: 100_000,
      focusPages: [],
      currentPage: 25
    })
    expect(out).toContain('[[page 25]]')
    expect(out).toContain('[[page 24]]')
    expect(out.length).toBeLessThanOrEqual(100_000)
  })

  it('never exceeds a budget smaller than the mandatory pages', () => {
    const out = assembleDocument(pages(10, 10_000), { budget: 5_000, focusPages: [5] })
    expect(out.length).toBeLessThanOrEqual(5_000)
  })
})
