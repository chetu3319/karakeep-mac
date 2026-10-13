/**
 * Turns the model's light Markdown into plain text runs that a page-injected
 * script can render with createElement('b') + text nodes only. The web reader
 * draws inside an untrusted page, so nothing here ever produces HTML: the
 * output is data (`text` + `bold`), never markup.
 */
export interface TextSegment {
  text: string
  bold: boolean
}

function stripInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/`/g, '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1$2')
}

export function markdownSegments(md: string): TextSegment[] {
  const prepared = md
    .replace(/```[a-zA-Z0-9]*\n?/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/__([^_\n]+)__/g, '**$1**')

  const out: TextSegment[] = []
  let bold = false
  // An odd trailing `**` (a bold run still streaming in) just stays open, so
  // the raw delimiter is never shown.
  for (const part of prepared.split('**')) {
    const text = stripInline(part)
    if (text) {
      const last = out[out.length - 1]
      if (last && last.bold === bold) last.text += text
      else out.push({ text, bold })
    }
    bold = !bold
  }
  return out
}
