import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderMarkdown } from './miniMarkdown'

// parseRefs swaps each reference marker for U+2063 R{index} U+2063 before the
// text reaches the markdown renderer; renderRef decides what takes its place.
const S = '⁣'

describe('renderMarkdown renderRef', () => {
  it('renders the sentinel through renderRef, in place', () => {
    const html = renderToStaticMarkup(
      renderMarkdown(`a ${S}R0${S} b`, { renderRef: (i) => `[${i}]` }) as never
    )
    expect(html).toBe('<p class="mb-2 last:mb-0">a [0] b</p>')
  })

  it('handles several refs and emphasis around them', () => {
    const html = renderToStaticMarkup(
      renderMarkdown(`**bold**${S}R0${S} and ${S}R1${S}.`, { renderRef: (i) => `<${i}>` }) as never
    )
    expect(html).toContain('<strong>bold</strong>&lt;0&gt; and &lt;1&gt;.')
  })

  it('drops the sentinel when no renderRef is given', () => {
    const html = renderToStaticMarkup(renderMarkdown(`a ${S}R0${S}b`) as never)
    expect(html).not.toContain(S)
    expect(html).toContain('a b')
  })
})

describe('renderMarkdown refs in verbatim blocks', () => {
  it('never shows R0 inside fenced code or display math', () => {
    const fenced = renderToStaticMarkup(
      renderMarkdown(`\`\`\`\nx = 1 ${S}R0${S}\n\`\`\``, { renderRef: () => 'TAG' }) as never
    )
    expect(fenced).toContain('x = 1 ')
    expect(fenced).not.toMatch(/R0|TAG/)
    const math = renderToStaticMarkup(renderMarkdown(`$$a+b ${S}R0${S}$$`, { renderRef: () => 'TAG' }) as never)
    expect(math).not.toMatch(/R0|TAG/)
  })
})
