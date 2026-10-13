import { describe, expect, it } from 'vitest'
import { markdownSegments } from './safeMarkdown'

describe('markdownSegments', () => {
  it('splits bold runs', () => {
    expect(markdownSegments('a **b** c')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false }
    ])
  })

  it('keeps an unclosed bold run bold and never shows the delimiter', () => {
    const segs = markdownSegments('x **partial')
    expect(segs).toEqual([
      { text: 'x ', bold: false },
      { text: 'partial', bold: true }
    ])
    expect(markdownSegments('end **').map((s) => s.text).join('')).toBe('end ')
  })

  it('strips headings, code ticks, italics and turns bullets into dots', () => {
    const text = markdownSegments('# Title\n- one\n* two\nuse `x` and *em*')
      .map((s) => s.text)
      .join('')
    expect(text).toBe('Title\n• one\n• two\nuse x and em')
  })

  it('treats markup in model text as plain data', () => {
    const segs = markdownSegments('<img src=x onerror=alert(1)> **<b>hi</b>**')
    expect(segs.map((s) => s.text).join('')).toBe('<img src=x onerror=alert(1)> <b>hi</b>')
    expect(segs[segs.length - 1].bold).toBe(true)
  })

  it('returns nothing for empty input', () => {
    expect(markdownSegments('')).toEqual([])
  })
})
