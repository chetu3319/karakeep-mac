import { describe, expect, it } from 'vitest'
import { locatePdfRef } from './revealRef'
import type { AiRef } from './aiRefs'

const ref = (quote: string, page?: number): AiRef => ({ index: 0, quote, page, figure: false })
const pagesOf = (pages: string[]) => async (i: number) => pages[i] ?? ''

describe('locatePdfRef', () => {
  const pages = ['one', 'two', 'three', 'four plain', 'five', 'six has the needle phrase here', 'seven']

  it('finds an exact match on the hinted page', async () => {
    const r = await locatePdfRef(ref('plain', 4), pages.length, pagesOf(pages))
    expect(r).toEqual({ quality: 'exact', page0: 3, start: 5, end: 10 })
  })

  it('finds a quote on a nearby page when the hint is off', async () => {
    const r = await locatePdfRef(ref('the needle phrase', 4), pages.length, pagesOf(pages))
    expect(r).toMatchObject({ quality: 'exact', page0: 5 })
  })

  it('falls back to the hinted page when the passage is not found', async () => {
    const r = await locatePdfRef(ref('nothing like this', 4), pages.length, pagesOf(pages))
    expect(r).toEqual({ quality: 'approximate', page0: 3 })
  })

  it('is missing when nothing matches and there is no hint', async () => {
    const r = await locatePdfRef(ref('nothing like this'), pages.length, pagesOf(pages))
    expect(r).toEqual({ quality: 'missing' })
  })

  it('is missing when the hint is outside the document', async () => {
    const r = await locatePdfRef(ref('nothing like this', 99), pages.length, pagesOf(pages))
    expect(r).toEqual({ quality: 'missing' })
  })

  it('matches a quote hyphenated across a line break', async () => {
    const r = await locatePdfRef(ref('pay attention to this', 2), 2, pagesOf(['x', 'we pay atten-\ntion to this now']))
    expect(r).toMatchObject({ quality: 'exact', page0: 1 })
  })
})
