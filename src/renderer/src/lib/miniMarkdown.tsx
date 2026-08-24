import React from 'react'

/**
 * A small, deliberately non-exhaustive Markdown renderer for Gemini's
 * streamed responses.
 *
 * The system prompt in main/ai.ts asks the model to "use clear formatting
 * and bullet points", and it reliably does — headings, **bold**, `code`,
 * fenced blocks, and both list styles show up constantly. Rendering that in
 * a `whitespace-pre-wrap` div (the previous approach) means the user reads
 * literal asterisks and backticks instead of formatting, which reads as
 * broken rather than as plain text.
 *
 * This builds real React elements rather than ever touching innerHTML —
 * SelectionAiHUD and PageAiDrawer render model output, which is untrusted
 * text from the user's own document via an LLM, and `dangerouslySetInnerHTML`
 * on that would be a stored-XSS vector the moment a page manages to get its
 * own markup echoed back through a completion. Building elements keeps
 * React's own escaping in force for every text node.
 *
 * Deliberately not a general Markdown implementation: tables, links, nested
 * blockquotes, and nested lists are not attempted. Gemini's actual output in
 * this app's prompts is answer prose, not documents that need those.
 */

let keySeed = 0
function nextKey(): string {
  keySeed += 1
  return `md-${keySeed}`
}

/** Bold, italic, and inline code within a single line of text. */
function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  // Order matters: inline code is matched first so `**not bold**` inside a
  // code span is never mistaken for emphasis markers.
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    if (match[1] !== undefined) {
      nodes.push(
        <code
          key={nextKey()}
          className="rounded bg-neutral-200/70 px-1 py-0.5 font-mono text-[0.9em] dark:bg-neutral-700/70"
        >
          {match[1]}
        </code>
      )
    } else if (match[2] !== undefined || match[3] !== undefined) {
      nodes.push(<strong key={nextKey()}>{match[2] ?? match[3]}</strong>)
    } else {
      nodes.push(<em key={nextKey()}>{match[4] ?? match[5]}</em>)
    }
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

interface ListBlock {
  type: 'ul' | 'ol'
  items: string[]
}

/** Parses a block of Markdown-ish text into React elements. */
export function renderMarkdown(source: string): React.ReactNode {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []

  let i = 0
  let paragraph: string[] = []
  let list: ListBlock | null = null

  function flushParagraph(): void {
    if (!paragraph.length) return
    blocks.push(
      <p key={nextKey()} className="mb-2 last:mb-0">
        {renderInline(paragraph.join(' '))}
      </p>
    )
    paragraph = []
  }

  function flushList(): void {
    if (!list) return
    const Tag = list.type
    blocks.push(
      <Tag key={nextKey()} className={Tag === 'ul' ? 'mb-2 list-disc pl-4 last:mb-0' : 'mb-2 list-decimal pl-4 last:mb-0'}>
        {list.items.map((item) => (
          <li key={nextKey()}>{renderInline(item)}</li>
        ))}
      </Tag>
    )
    list = null
  }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block — consumed verbatim until the closing fence (or EOF).
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      flushParagraph()
      flushList()
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

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushParagraph()
      flushList()
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

    const ulItem = line.match(/^\s*[-*]\s+(.*)$/)
    const olItem = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ulItem || olItem) {
      flushParagraph()
      const type = ulItem ? 'ul' : 'ol'
      const text = (ulItem ?? olItem)![1]
      if (list && list.type === type) {
        list.items.push(text)
      } else {
        flushList()
        list = { type, items: [text] }
      }
      i++
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      flushList()
      i++
      continue
    }

    flushList()
    paragraph.push(line.trim())
    i++
  }

  flushParagraph()
  flushList()

  return blocks
}

export default function Markdown({ text, className }: { text: string; className?: string }): React.JSX.Element {
  return <div className={className}>{renderMarkdown(text)}</div>
}
