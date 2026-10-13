import { describe, expect, it } from 'vitest'
import {
  fitLongSide,
  glyphSpansInRect,
  isTinyDrag,
  pickPage,
  rectFromPoints,
  regionLabel,
  renderScaleFor,
  screenToPageRect,
  tidyRegionText
} from './regionCapture'

describe('region capture helpers', () => {
  it('builds a rectangle whichever way the drag went', () => {
    expect(rectFromPoints(50, 60, 10, 20)).toEqual({ x: 10, y: 20, width: 40, height: 40 })
  })

  it('treats drags under 8px on either side as cancelled', () => {
    expect(isTinyDrag({ width: 7, height: 100 })).toBe(true)
    expect(isTinyDrag({ width: 100, height: 7.9 })).toBe(true)
    expect(isTinyDrag({ width: 8, height: 8 })).toBe(false)
  })

  it('converts a screen drag to page units, clipped to the page', () => {
    const page = { page: 2, box: { x: 100, y: 200, width: 600, height: 800 }, pageWidth: 300 }
    const r = screenToPageRect({ x: 160, y: 260, width: 100, height: 50 }, page)!
    expect(r.scale).toBe(2)
    expect(r).toMatchObject({ x: 30, y: 30, width: 50, height: 25 })
    // hanging off the page's left/top edge is clipped to it
    const c = screenToPageRect({ x: 50, y: 150, width: 100, height: 100 }, page)!
    expect(c).toMatchObject({ x: 0, y: 0, width: 25, height: 25 })
    expect(screenToPageRect({ x: 0, y: 0, width: 10, height: 10 }, page)).toBeNull()
  })

  it('picks the page the drag covers most', () => {
    const pages = [
      { page: 0, box: { x: 0, y: 0, width: 100, height: 100 }, pageWidth: 100 },
      { page: 1, box: { x: 0, y: 110, width: 100, height: 100 }, pageWidth: 100 }
    ]
    expect(pickPage({ x: 10, y: 85, width: 20, height: 60 }, pages)?.page).toBe(1)
    expect(pickPage({ x: 500, y: 500, width: 5, height: 5 }, pages)).toBeNull()
  })

  it('renders sharp but never past the long-side cap', () => {
    expect(renderScaleFor(100, 100, 1.5, 2)).toBe(3)
    expect(renderScaleFor(1000, 400, 1.5, 2)).toBeCloseTo(1.6)
  })

  it('downsizes the long side to the cap and keeps aspect', () => {
    expect(fitLongSide(800, 600)).toEqual({ width: 800, height: 600 })
    expect(fitLongSide(3200, 1600)).toEqual({ width: 1600, height: 800 })
    expect(fitLongSide(1000, 4000)).toEqual({ width: 400, height: 1600 })
  })

  it('labels figures by their caption and everything else as a region', () => {
    expect(regionLabel('Figure 3. Loss curves', 4)).toBe('Figure · p.4')
    expect(regionLabel('  fig. 2 shows', 1)).toBe('Figure · p.1')
    expect(regionLabel('E = mc^2', 7)).toBe('Region · p.7')
    expect(regionLabel('anything')).toBe('Region')
  })

  it('tidies and bounds region text', () => {
    expect(tidyRegionText('  a \n b  ')).toBe('a b')
    expect(tidyRegionText('x'.repeat(50), 10)).toHaveLength(10)
  })

  it('finds the glyph runs that touch the rectangle', () => {
    const g = (x: number, y = 0) => ({ x, y, width: 10, height: 10 })
    const runs = [
      { charStart: 0, glyphs: [g(0), g(10), g(20)] },
      { charStart: 3, glyphs: [g(0, 50), g(10, 50)] }
    ]
    expect(glyphSpansInRect(runs, { x: 12, y: 2, width: 30, height: 5 })).toEqual([{ from: 1, to: 2 }])
    expect(glyphSpansInRect(runs, { x: 0, y: 0, width: 100, height: 100 })).toEqual([{ from: 0, to: 4 }])
    expect(glyphSpansInRect(runs, { x: 200, y: 200, width: 5, height: 5 })).toEqual([])
  })
})
