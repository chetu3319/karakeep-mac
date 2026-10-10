import React from 'react'
import katex from 'katex'

/**
 * A small, deliberately non-exhaustive Markdown renderer for Gemini's
 * streamed responses.
 *
 * The system prompt in main/ai.ts asks the model to "use clear formatting
 * and bullet points", and it reliably does — headings, **bold**, `code`,
 * fenced blocks, both list styles, and (particularly for anything
 * math-adjacent) LaTeX all show up constantly. Rendering that in a
 * `whitespace-pre-wrap` div (the previous approach) means the user reads
 * literal asterisks, backticks, and `\mathbf{}` instead of formatting, which
 * reads as broken rather than as plain text.
 *
 * This builds real React elements rather than ever touching innerHTML —
 * SelectionAiHUD and PageAiDrawer render model output, which is untrusted
 * text from the user's own document via an LLM, and `dangerouslySetInnerHTML`
 * on that would be a stored-XSS vector the moment a page manages to get its
 * own markup echoed back through a completion. Building elements keeps
 * React's own escaping in force for every text node.
 *
 * ONE deliberate exception: the `<Katex>` component below uses
 * `dangerouslySetInnerHTML` to inject KaTeX's rendered output. This is safe
 * despite the rule above because KaTeX's `renderToString` does not echo its
 * input back as markup — it parses the LaTeX into its own AST and emits HTML
 * built entirely from that AST (glyphs, spans, and layout CSS), escaping any
 * literal text it needs to display. We also pass `trust: false`, which is
 * KaTeX's own switch for disallowing the handful of commands that *can*
 * produce attacker-influenced markup or navigation (`\href`, `\url`,
 * `\includegraphics`, etc.) — with it off, those commands render as errors
 * instead of HTML. So the only content that reaches innerHTML is HTML KaTeX
 * itself constructed from a fixed set of math primitives, never a pass-
 * through of the model's raw string. `strict: 'ignore'` just silences
 * console warnings for LaTeX-isms KaTeX considers non-standard (e.g. some
 * spacing macros) — it doesn't affect what markup can be produced.
 *
 * Deliberately not a general Markdown implementation: nested blockquotes,
 * footnotes, and reference-style links are not attempted. Gemini's actual
 * output in this app's prompts is answer prose (with occasional math and
 * tables), not documents that need those.
 */

let keySeed = 0
function nextKey(): string {
  keySeed += 1
  return `md-${keySeed}`
}

/**
 * Renders a single KaTeX expression. This is the one place in this file
 * that uses `dangerouslySetInnerHTML` — see the file header for why that's
 * safe here (KaTeX builds the HTML from its own parsed AST with
 * `trust: false`, it never echoes the input string as markup).
 *
 * If KaTeX can't parse the expression (the model wrote something malformed,
 * or cut off mid-stream), we fall back to showing the raw source in a
 * `<code>` span rather than throwing and taking down the whole chat message.
 */
function Katex({ expr, displayMode }: { expr: string; displayMode: boolean }): React.JSX.Element {
  let html: string | null = null
  try {
    html = katex.renderToString(expr, {
      throwOnError: false,
      displayMode,
      output: 'html',
      trust: false,
      strict: 'ignore'
    })
  } catch {
    html = null
  }
  if (html === null) {
    return <code className="rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[0.9em] dark:bg-neutral-700/70">{expr}</code>
  }
  const Tag = displayMode ? 'div' : 'span'
  return <Tag className={displayMode ? 'my-1 overflow-x-auto' : undefined} dangerouslySetInnerHTML={{ __html: html }} />
}

/** Only these URL schemes are ever rendered as clickable links (see Link below). */
const ALLOWED_LINK_SCHEMES = ['http:', 'https:', 'mailto:']

function isAllowedLinkUrl(url: string): boolean {
  try {
    // mailto: URLs don't have a meaningful base, but `new URL` still parses
    // their scheme correctly without one.
    const parsed = new URL(url)
    return ALLOWED_LINK_SCHEMES.includes(parsed.protocol)
  } catch {
    return false
  }
}

/**
 * A Markdown link. Never a plain `<a href>` — this renders inside Electron's
 * main window, not a browser tab, so a real navigation would blow away the
 * whole app UI. Instead this behaves like a link (role, cursor, underline)
 * but hands the URL to the main process via `window.kk.webpane.openExternal`,
 * which opens it in the user's actual browser (see main/index.ts's
 * WEBPANE_OPEN_EXTERNAL handler). Anything other than http(s)/mailto renders
 * as plain text so a model can't emit `javascript:` or `file:` links.
 */
function Link({ href, children }: { href: string; children: React.ReactNode }): React.JSX.Element {
  if (!isAllowedLinkUrl(href)) return <>{children}</>
  return (
    <a
      href="#"
      role="link"
      className="text-blue-600 underline decoration-blue-600/40 underline-offset-2 hover:decoration-blue-600 dark:text-blue-400 dark:decoration-blue-400/40 dark:hover:decoration-blue-400"
      onClick={(e) => {
        e.preventDefault()
        void window.kk.webpane.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

// Matches inline math: `$$...$$` (checked first — see below), `$...$` (no
// leading/trailing whitespace inside, non-empty, and no embedded `$`), or
// `\(...\)`. Deliberately requires the closing delimiter on the same match
// so "it costs $5 and $10 total" is never mistaken for math — `$5 and $10`
// would need inner text starting/ending with digits either side of a lone
// `$`, but since there's no *second* `$` immediately closing a
// non-whitespace-bounded span, this simply won't match across "$5 and $10"
// as one expression, and single `$5`/`$10` tokens never find a same-line
// partner that isn't whitespace-padded.
//
// `$$...$$` has to be its own alternative, tried before the single-`$`
// pattern, rather than falling out of it naturally: `$$E=mc^2$$` fed to only
// the single-`$` alternative matches starting at the *second* `$` (since the
// first `$` can't open a match — its very next character is also `$`, which
// the content class excludes), consuming through to the first of the
// trailing pair and leaving one stray `$` on each side un-rendered. This
// alternative only covers `$$...$$` that appears embedded inside a line of
// other text; `$$` opening a whole line is handled earlier, as a display-math
// block, by `matchDisplayMathOpen`.
const INLINE_MATH = /\$\$([^$\n]+?)\$\$|\$((?!\s)[^$\n]*[^\s$]|(?!\s)[^\s$])\$|\\\(([^)]+?)\\\)/

/**
 * Splits inline text into plain-text and math segments, before any other
 * inline formatting is applied. Math has to be tokenized first: if bold/
 * italic ran first, `$a_*b*$` would have its `*b*` treated as emphasis
 * markers and mangle the LaTeX before KaTeX ever sees it. Inline code spans
 * still take priority over math (checked first in the loop below), matching
 * normal Markdown semantics where backticks escape everything inside them.
 */
function splitMathAndCode(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const pattern = new RegExp(`\`([^\`]+)\`|${INLINE_MATH.source}`, 'g')
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(renderEmphasis(text.slice(lastIndex, match.index)))
    if (match[1] !== undefined) {
      nodes.push(
        <code
          key={nextKey()}
          className="rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[0.9em] dark:bg-neutral-700/70"
        >
          {match[1]}
        </code>
      )
    } else {
      const expr = match[2] ?? match[3] ?? match[4]
      nodes.push(<Katex key={nextKey()} expr={expr} displayMode={false} />)
    }
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < text.length) nodes.push(renderEmphasis(text.slice(lastIndex)))
  return nodes
}

/** Bold, italic, strikethrough, and links within a plain-text run (math and code already removed). */
function renderEmphasis(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*|_([^_]+)_/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    if (match[1] !== undefined || match[2] !== undefined) {
      nodes.push(<strong key={nextKey()}>{match[1] ?? match[2]}</strong>)
    } else if (match[3] !== undefined) {
      nodes.push(<s key={nextKey()}>{match[3]}</s>)
    } else if (match[4] !== undefined) {
      nodes.push(
        <Link key={nextKey()} href={match[5]}>
          {match[4]}
        </Link>
      )
    } else {
      nodes.push(<em key={nextKey()}>{match[6] ?? match[7]}</em>)
    }
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

/** Bold, italic, inline code, inline math, strikethrough, and links within a single line of text. */
function renderInline(text: string): React.ReactNode[] {
  return splitMathAndCode(text)
}

/** One item in a (possibly nested) list, keyed by its indent depth. */
interface ListItemNode {
  text: string
  children: ListBlock[]
}

interface ListBlock {
  type: 'ul' | 'ol'
  start: number
  items: ListItemNode[]
  indent: number
}

/** Matches a bullet or ordered list marker, capturing leading indentation. */
const UL_MARKER = /^(\s*)[-*+]\s+(.*)$/
const OL_MARKER = /^(\s*)(\d+)\.\s+(.*)$/

/** Indentation width per nesting level. A tab counts as one level on its own. */
function indentWidth(indent: string): number {
  if (indent.includes('\t')) return indent.split('\t').length - 1 || 1
  return Math.floor(indent.length / 2)
}

/**
 * Parses a run of consecutive list-item lines (from `lines[start]`) into a
 * nested ListBlock tree, honouring indentation for nesting and blank lines
 * that separate items without ending the list. Returns the block and the
 * index of the first line that isn't part of it.
 *
 * Markdown numbering convention: the source can write `1.` for every item
 * (very common in LLM output) and the rendered list still counts up — we
 * only use the *first* item's number as the `start` for `<ol>`, and let the
 * browser number every subsequent `<li>` automatically.
 *
 * `allowTypeSwitch` handles a pattern Gemini reliably produces: a numbered
 * item followed by a `*`/`-` sub-point at the *same* (zero) indentation,
 * e.g. "1. Foo:\n\n* explains foo\n\n1. Bar:\n\n* explains bar". Real
 * indentation-based nesting (the `indent > baseIndent` branch below) doesn't
 * fire here since the bullet isn't indented at all — without this, each
 * "1." line would end up as a separate one-item `<ol>` (which is exactly the
 * "numbering restarts at 1 for every item, sub-bullets flatten the list"
 * bug this file was built to fix). We treat a same-indent marker-type switch
 * as an implicit nested list under the previous item instead of a sibling
 * list. `allowTypeSwitch: false` is passed to the nested call this creates
 * so it only consumes that one run of the other type and hands control back
 * the moment the type flips again — the outer numbered list stays flat and
 * keeps counting, rather than the two types spiralling into ever-deeper
 * nesting. This is a heuristic, not real Markdown: two genuinely unrelated
 * top-level lists of different bullet styles placed back-to-back with only
 * a blank line between them will also get merged this way. That's an
 * acceptable trade-off for AI chat prose (which doesn't do that) in
 * exchange for fixing the much more common alternating-list shape above.
 */
function parseList(lines: string[], start: number, allowTypeSwitch = true): { block: ListBlock; next: number } {
  const first = lines[start]
  const firstUl = first.match(UL_MARKER)
  const firstOl = first.match(OL_MARKER)
  const baseIndent = indentWidth((firstUl ?? firstOl)![1])
  const type: 'ul' | 'ol' = firstUl ? 'ul' : 'ol'
  const startNum = firstOl ? parseInt(firstOl[2], 10) : 1

  const items: ListItemNode[] = []
  let i = start

  while (i < lines.length) {
    // A single blank line between items doesn't end the list — only a
    // subsequent non-list, non-indented-continuation line does.
    if (!lines[i].trim()) {
      const after = lines[i + 1]
      const afterUl = after?.match(UL_MARKER)
      const afterOl = after?.match(OL_MARKER)
      const afterIndent = after !== undefined ? indentWidth((afterUl ?? afterOl ?? ['', ''])[1]) : -1
      // `>=`, not `==`: a blank line before a *deeper* indented sub-list
      // ("1. Foo\n\n    - detail") is just as much a continuation of this
      // list as a blank line before a sibling item, and the nesting branch
      // below is what actually consumes it.
      if ((afterUl || afterOl) && afterIndent >= baseIndent) {
        i++ // swallow the blank line, keep going
        continue
      }
      break
    }

    const ul = lines[i].match(UL_MARKER)
    const ol = lines[i].match(OL_MARKER)
    if (!ul && !ol) break
    const indent = indentWidth((ul ?? ol)![1])

    if (indent < baseIndent) break // dedent — belongs to an ancestor list

    if (indent > baseIndent) {
      // Nested sub-list: parse it recursively and attach to the last item.
      const { block, next } = parseList(lines, i)
      const last = items[items.length - 1]
      if (last) {
        last.children.push(block)
      }
      i = next
      continue
    }

    const itemType = ul ? 'ul' : 'ol'
    if (itemType !== type) {
      // See the `allowTypeSwitch` doc comment above — a same-indent marker
      // switch nests as a sub-list of the previous item rather than ending
      // this list, but only one level: the nested call gets
      // `allowTypeSwitch: false` so it can't itself re-nest back into this
      // type and unwind into infinite alternating depth.
      if (!allowTypeSwitch || items.length === 0) break
      const { block, next } = parseList(lines, i, false)
      items[items.length - 1].children.push(block)
      i = next
      continue
    }

    const text = (ul ?? ol)![ul ? 2 : 3]
    items.push({ text, children: [] })
    i++
  }

  return { block: { type, start: startNum, items, indent: baseIndent }, next: i }
}

function renderList(block: ListBlock): React.JSX.Element {
  const Tag = block.type
  const className =
    block.type === 'ul' ? 'mb-2 list-disc pl-4 last:mb-0 marker:text-neutral-400 dark:marker:text-neutral-500' : 'mb-2 list-decimal pl-4 last:mb-0 marker:text-neutral-400 dark:marker:text-neutral-500'
  return (
    <Tag key={nextKey()} className={className} {...(block.type === 'ol' && block.start !== 1 ? { start: block.start } : {})}>
      {block.items.map((item) => (
        <li key={nextKey()} className="mb-0.5 last:mb-0">
          {renderInline(item.text)}
          {item.children.map((child) => renderList(child))}
        </li>
      ))}
    </Tag>
  )
}

/** Matches a whole-line display-math block: `$$...$$` or `\[...\]`, possibly spanning to a closing line. */
function matchDisplayMathOpen(line: string): { delim: '$$' | '\\['; rest: string } | null {
  const dollar = line.match(/^\s*\$\$(.*)$/)
  if (dollar) return { delim: '$$', rest: dollar[1] }
  const bracket = line.match(/^\s*\\\[(.*)$/)
  if (bracket) return { delim: '\\[', rest: bracket[1] }
  return null
}

/** Parses a block of Markdown-ish text into React elements. */
export function renderMarkdown(source: string): React.ReactNode {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []

  let i = 0
  let paragraph: string[] = []

  function flushParagraph(): void {
    if (!paragraph.length) return
    blocks.push(
      <p key={nextKey()} className="mb-2 last:mb-0">
        {renderInline(paragraph.join(' '))}
      </p>
    )
    paragraph = []
  }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block — consumed verbatim until the closing fence (or EOF).
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      flushParagraph()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing fence (or run off the end harmlessly)
      blocks.push(
        <pre
          key={nextKey()}
          className="mb-2 overflow-x-auto rounded-md bg-neutral-900 p-2.5 text-[11px] leading-relaxed text-neutral-100 last:mb-0 dark:bg-black/60"
        >
          <code>{codeLines.join('\n')}</code>
        </pre>
      )
      continue
    }

    // Display math block: `$$ ... $$` or `\[ ... \]`, either on one line or
    // spanning several. Checked before headings/lists/etc. since it can
    // occupy a whole block on its own.
    const displayOpen = matchDisplayMathOpen(line)
    if (displayOpen) {
      flushParagraph()
      const closeRe = displayOpen.delim === '$$' ? /\$\$\s*$/ : /\\\]\s*$/
      const exprLines: string[] = []
      let rest = displayOpen.rest
      // Single-line case: `$$ ... $$` with both delimiters on this line.
      const sameLineClose = rest.match(displayOpen.delim === '$$' ? /^(.*)\$\$\s*$/ : /^(.*)\\\]\s*$/)
      if (sameLineClose) {
        exprLines.push(sameLineClose[1])
        i++
      } else {
        exprLines.push(rest)
        i++
        while (i < lines.length && !closeRe.test(lines[i])) {
          exprLines.push(lines[i])
          i++
        }
        if (i < lines.length) {
          exprLines.push(lines[i].replace(closeRe, ''))
          i++
        }
      }
      const expr = exprLines.join('\n').trim()
      blocks.push(<Katex key={nextKey()} expr={expr} displayMode={true} />)
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushParagraph()
      const level = heading[1].length
      const sizeClass = level <= 2 ? 'text-sm font-semibold' : 'text-xs font-semibold'
      const HeadingTag = (`h${Math.min(level, 6)}` as unknown) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      blocks.push(
        <HeadingTag key={nextKey()} className={`mb-1.5 mt-2.5 first:mt-0 ${sizeClass}`}>
          {renderInline(heading[2])}
        </HeadingTag>
      )
      i++
      continue
    }

    // Horizontal rule: a line of 3+ `-`, `*`, or `_` (optionally spaced), and
    // nothing else. Checked before list matching since `---` would otherwise
    // never match the bullet/ordered patterns anyway, but `***` could be
    // confused with emphasis if it reached renderInline.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph()
      blocks.push(<hr key={nextKey()} className="my-3 border-neutral-200 dark:border-neutral-700" />)
      i++
      continue
    }

    // Blockquote — collects consecutive `>` lines (stripping one leading
    // `>` and an optional space) and renders their contents as normal
    // inline-formatted text.
    if (/^\s*>\s?/.test(line)) {
      flushParagraph()
      const quoteLines: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote
          key={nextKey()}
          className="mb-2 border-l-2 border-neutral-300 pl-2.5 text-neutral-600 last:mb-0 dark:border-neutral-600 dark:text-neutral-400"
        >
          {renderInline(quoteLines.join(' '))}
        </blockquote>
      )
      continue
    }

    // GFM pipe table: a header row, a `---|---` separator row, then body
    // rows. If the separator row doesn't follow, this isn't a table — fall
    // through to paragraph handling for the first line.
    if (/\|/.test(line) && lines[i + 1] && /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(lines[i + 1])) {
      flushParagraph()
      const splitRow = (row: string): string[] =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim())
      const header = splitRow(line)
      i += 2
      const bodyRows: string[][] = []
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        bodyRows.push(splitRow(lines[i]))
        i++
      }
      blocks.push(
        <div key={nextKey()} className="mb-2 overflow-x-auto last:mb-0">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                {header.map((cell) => (
                  <th
                    key={nextKey()}
                    className="border-b border-neutral-300 px-2 py-1 font-semibold dark:border-neutral-600"
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row) => (
                <tr key={nextKey()}>
                  {row.map((cell) => (
                    <td key={nextKey()} className="border-b border-neutral-200 px-2 py-1 align-top dark:border-neutral-800">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    if (UL_MARKER.test(line) || OL_MARKER.test(line)) {
      flushParagraph()
      const { block, next } = parseList(lines, i)
      blocks.push(renderList(block))
      i = next
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      i++
      continue
    }

    paragraph.push(line.trim())
    i++
  }

  flushParagraph()

  return blocks
}

export default function Markdown({ text, className }: { text: string; className?: string }): React.JSX.Element {
  return <div className={className}>{renderMarkdown(text)}</div>
}
