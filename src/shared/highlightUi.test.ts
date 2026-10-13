import { describe, expect, it } from 'vitest'
import { highlightPopoverStylesheet } from './highlightUi'

describe('highlightPopoverStylesheet AI card', () => {
  const css = highlightPopoverStylesheet()

  it('sizes the expanded card to its toolbar, with a floor', () => {
    expect(css).toMatch(/\.kh-pop\.kh-ai-mode \{[^}]*width: fit-content;[^}]*min-width: 360px/)
  })

  it('keeps the answer rows from widening the card', () => {
    expect(css).toMatch(/\.kh-pop\.kh-ai-mode > \* \{ width: 0; min-width: 100%; \}/)
  })
})
