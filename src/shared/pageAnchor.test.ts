// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createAnchorer, normalizeWithMap } from './pageAnchor'

// jsdom does no layout, so every element would measure 0x0 and read as
// hidden; treat everything outside an explicit [hidden] subtree as drawn.
const anchorer = createAnchorer({
  highlightClass: 'kh',
  overlayHostId: 'overlay',
  isRendered: (el) => !el.closest('[hidden]')
})

beforeEach(() => {
  anchorer.resetVisibilityCache()
})

describe('normalizeWithMap', () => {
  it('collapses whitespace and folds smart punctuation, keeping the index map', () => {
    const { norm, map } = normalizeWithMap('It’s  a\n“test”…')
    expect(norm).toBe('It\'s a "test"...')
    expect(map[3]).toBe(3)
    // The three dots all map back to the single ellipsis character.
    expect(map.slice(-3)).toEqual([14, 14, 14])
  })
})

describe('locateText', () => {
  it('finds text that spans several elements', () => {
    document.body.innerHTML = '<p>The <b>quick</b> brown fox</p>'
    const range = anchorer.locateText('quick brown')
    expect(range?.toString()).toBe('quick brown')
  })

  it('matches across smart quotes and collapsed whitespace', () => {
    document.body.innerHTML = '<p>She said “hello   there” twice.</p>'
    expect(anchorer.locateText('said "hello there"')?.toString()).toBe('said “hello   there”')
  })

  it('skips hidden duplicates and the overlay', () => {
    document.body.innerHTML =
      '<div hidden>needle text</div><div id="overlay">needle text</div><p>a needle text b</p>'
    const range = anchorer.locateText('needle text')
    expect(range?.startContainer.parentElement?.tagName).toBe('P')
  })

  it('uses the stored offset to pick between repeated occurrences', () => {
    document.body.innerHTML = '<p>Abstract one. Abstract two. Abstract three.</p>'
    const range = anchorer.locateText('Abstract', undefined, undefined, 28)
    expect(range?.startOffset).toBe(28)
  })

  it('uses prefix/suffix context ahead of position', () => {
    document.body.innerHTML = '<p>red apple, green apple, blue apple</p>'
    const range = anchorer.locateText('apple', 'green ', ', blue')
    expect(range?.startOffset).toBe(17)
  })

  it('falls back to the head of an edited passage', () => {
    document.body.innerHTML = '<p>The opening of this long sentence survives but the ending changed.</p>'
    const range = anchorer.locateText('The opening of this long sentence survives and then something else')
    expect(range?.toString()).toBe('The opening of this long sentence survives ')
  })

  it('returns null when nothing matches', () => {
    document.body.innerHTML = '<p>nothing here</p>'
    expect(anchorer.locateText('absent')).toBeNull()
  })
})

describe('wrapRange / unwrap', () => {
  it('wraps each text node in a mark and restores the DOM on unwrap', () => {
    document.body.innerHTML = '<p>The <b>quick</b> brown fox</p>'
    const before = document.body.innerHTML
    const range = anchorer.locateText('quick brown')!
    const marks = anchorer.wrapRange(range, 'h1', 'green')
    expect(marks).toHaveLength(2)
    expect(anchorer.marksFor('h1').map((m) => m.textContent).join('')).toBe('quick brown')
    expect(marks[0].dataset.khColor).toBe('green')
    anchorer.unwrap(anchorer.marksFor('h1'))
    expect(document.body.innerHTML).toBe(before)
  })
})

describe('textOffsetOf / extractContext', () => {
  it('measures offsets over the rendered text stream', () => {
    document.body.innerHTML = '<p>Hello <i>big</i> world</p>'
    const range = anchorer.locateText('world')!
    expect(anchorer.textOffsetOf(range.startContainer, range.startOffset)).toBe(10)
    expect(anchorer.extractContext(range)).toEqual({ prefix: 'Hello big ', suffix: '' })
  })
})
