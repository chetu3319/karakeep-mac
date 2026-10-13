import type { AiStreamRequest } from '../shared/types'
import type { StudyAttachment, StudyMessage } from '../shared/study'

// Pure prompt assembly, kept free of Electron imports so it can be unit tested.

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }
export type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

/** Only this many of the most recent image-bearing user turns keep their pixels. */
const MAX_IMAGE_TURNS = 4

const STUDY_INSTRUCTIONS = [
  'You are a careful study partner embedded in a document reader. The reader is working through the document below and asks you questions about it. Answer from the document, be direct and rigorous, and use short paragraphs or bullets where they help. Avoid filler.',
  '',
  'References. Every factual claim about the document carries a reference to the passage that supports it, written as a marker inside the sentence it supports:',
  '  [[ref p=4 "exact words from the document"]]',
  '  [[ref fig p=4 "label or caption"]]   (when the reference is to a figure or region the reader attached as an image)',
  '  [[ref "exact words from the document"]]   (when the document has no page markers)',
  'Rules for markers:',
  '- The quote must be copied verbatim from the DOCUMENT text below, at most 25 words. Never paraphrase inside a quote, and never invent text.',
  '- p is the number of the nearest preceding [[page N]] marker in the DOCUMENT, when the document has them. Omit p when it has none.',
  '- Use the fig form only for a figure or region the reader attached; its quote is a short label or caption.',
  '- Put the marker right after the claim, before the closing punctuation. Use one marker per claim; several markers in a row are fine for several claims.',
  '- If the document does not say something, say so plainly instead of guessing, and do not add a marker.',
  'Write in plain language; explain jargon the first time it appears.'
].join('\n')

function dataUrlToInline(dataUrl: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  return m ? { mimeType: m[1], data: m[2] } : null
}

function attachmentLabel(a: StudyAttachment): string {
  const page = a.page != null ? ` (p.${a.page})` : ''
  if (a.kind === 'text') {
    const ctx = a.context ? `\nSurrounding context: ${a.context}` : ''
    return `Attached passage${page}: "${a.quote}"${ctx}`
  }
  const text = a.text ? `\nText in region: ${a.text}` : ''
  return `Attached figure/region${page}: ${a.label}${text}`
}

function studyContents(req: AiStreamRequest): GeminiContent[] {
  const messages: StudyMessage[] = req.studyMessages ?? []
  const hasImage = (m: StudyMessage): boolean =>
    m.role === 'user' &&
    (m.attachments ?? []).some((a) => a.kind === 'region' && !!a.imageDataUrl)

  // Indexes of the user turns that keep their images: the last MAX_IMAGE_TURNS.
  const keepImages = new Set<number>()
  for (let i = messages.length - 1; i >= 0 && keepImages.size < MAX_IMAGE_TURNS; i--) {
    if (hasImage(messages[i])) keepImages.add(i)
  }
  let lastUser = -1
  messages.forEach((m, i) => {
    if (m.role === 'user') lastUser = i
  })

  return messages.map((m, i) => {
    if (m.role === 'model') return { role: 'model', parts: [{ text: m.text }] }

    const lines = (m.attachments ?? []).map(attachmentLabel)
    if (i === lastUser && req.currentPage != null) lines.push(`Reader is on page ${req.currentPage}.`)
    lines.push(m.text)

    const parts: GeminiPart[] = [{ text: lines.join('\n') }]
    if (keepImages.has(i)) {
      for (const a of m.attachments ?? []) {
        if (a.kind !== 'region' || !a.imageDataUrl) continue
        const inline = dataUrlToInline(a.imageDataUrl)
        if (inline) parts.push({ inlineData: inline })
      }
    }
    return { role: 'user', parts }
  })
}

function studyPayload(req: AiStreamRequest): { systemInstruction: string; contents: GeminiContent[] } {
  // Nothing that changes from turn to turn may go in here, so the prefix stays
  // stable and the provider can cache it.
  const header: string[] = []
  if (req.docTitle) header.push(`Document Title: "${req.docTitle}"`)
  const source: string[] = []
  if (req.siteName) source.push(`Site: ${req.siteName}`)
  if (req.author) source.push(`Author: ${req.author}`)
  if (req.sourceUrl) source.push(`URL: ${req.sourceUrl}`)
  if (source.length) header.push(`Source: ${source.join(' | ')}`)

  const systemInstruction = [
    STUDY_INSTRUCTIONS,
    header.join('\n'),
    `--- DOCUMENT ---\n${req.documentText ?? ''}\n--- END DOCUMENT ---`
  ]
    .filter(Boolean)
    .join('\n\n')

  return { systemInstruction, contents: studyContents(req) }
}

export function buildPromptPayload(req: AiStreamRequest): {
  systemInstruction: string
  contents: GeminiContent[]
} {
  if (req.mode === 'study') return studyPayload(req)

  // "Paper" only fits a small slice of what this app now grounds chats
  // in — the same prompt runs against blog posts and the user's own
  // notes, where "the authors" and "this paper" read as obviously wrong.
  // `docKind` picks the noun that actually matches the surface the mode
  // was invoked from; PDF bookmarks are still overwhelmingly papers, so
  // that stays the default when the caller didn't say.
  const noun = req.docKind === 'note' ? 'note' : req.docKind === 'article' ? 'article' : 'paper'
  const authorNoun = noun === 'paper' ? 'the authors' : noun === 'note' ? 'the note' : 'the author'

  let systemInstruction =
    'You are an expert AI research co-pilot integrated directly into a flow-preserving document reader. ' +
    'Your goal is to maintain the reader\'s deep flow state and comprehension. ' +
    'Be direct, crisp, and intellectually rigorous. Use clear formatting and bullet points where helpful. Avoid generic fluff.'

  const contextSnippets: string[] = []
  if (req.docTitle) {
    contextSnippets.push(`Document Title: "${req.docTitle}"`)
  }
  // Source/site metadata the product spec calls "website/source info" —
  // gives the model enough to judge register, authority and intent (a
  // corporate blog post reads differently than an arxiv preprint) without
  // spending a whole extra round trip on it.
  const sourceParts: string[] = []
  if (req.siteName) sourceParts.push(`Site: ${req.siteName}`)
  if (req.author) sourceParts.push(`Author: ${req.author}`)
  if (req.sourceUrl) sourceParts.push(`URL: ${req.sourceUrl}`)
  if (sourceParts.length) {
    contextSnippets.push(`Source: ${sourceParts.join(' | ')}`)
  }
  if (req.pageText) {
    contextSnippets.push(`--- Active Page / Section Content ---\n${req.pageText}\n--- End Page Content ---`)
  }
  if (req.surroundingContext) {
    contextSnippets.push(`--- Immediate Surrounding Paragraph ---\n${req.surroundingContext}\n--- End Paragraph ---`)
  }

  let userPrompt = ''

  switch (req.mode) {
    // Dejargonify is folded into Explain: one prompt that asks for plain
    // language, so the legacy mode id maps to the same instruction.
    case 'micro-dejargon':
    case 'micro-explain':
      systemInstruction +=
        `\nTask: Explain the selected text strictly in the context of this ${noun}: what it means here, why ${authorNoun} say it, and how it connects to the surrounding argument. Use plain, jargon-free language without losing technical precision. Answer in at most 3 sentences.`
      userPrompt = `${contextSnippets.join('\n\n')}\n\nSelected Text to Explain:\n"${req.selectionText || ''}"`
      break

    case 'micro-define':
      systemInstruction +=
        `\nTask: Give a tight definition of the highlighted term. Cover both its general meaning and, if different, the specific sense it carries in this ${noun}. Answer in at most 3 sentences.`
      userPrompt = `${contextSnippets.join('\n\n')}\n\nTerm to Define:\n"${req.selectionText || ''}"`
      break

    case 'micro-formula':
      systemInstruction +=
        `\nTask: Mathematical and formula breakdown. Unpack the notation: the core intuition (what is this computing?), what each symbol represents, and why this formula is used here in the ${noun}. Answer in at most 3 sentences.`
      userPrompt = `${contextSnippets.join('\n\n')}\n\nEquation / Math Notation to Decode:\n"${req.selectionText || ''}"`
      break

    case 'meso-page':
      systemInstruction +=
        '\nTask: Answer questions specifically grounded in the active page / section text. Be accurate, cite specifics from the page, and explain figures or tables if referenced.'
      userPrompt = `${contextSnippets.join('\n\n')}\n\nUser Question:\n${req.prompt || 'Summarize the core idea and key takeaways of this page in 3 clear bullet points.'}`
      break

    case 'macro-chat':
    case 'custom':
    default:
      userPrompt = `${contextSnippets.join('\n\n')}`
      if (req.selectionText) {
        userPrompt += `\n\nSelected Text:\n"${req.selectionText}"`
      }
      if (req.prompt) {
        userPrompt += `\n\nQuestion / Request:\n${req.prompt}`
      }
      break
  }

  const contents: GeminiContent[] = []

  // Append prior chat history if provided
  if (req.history && req.history.length > 0) {
    for (const h of req.history) {
      contents.push({
        role: h.role === 'user' ? 'user' : 'model',
        parts: [{ text: h.text }]
      })
    }
  }

  contents.push({ role: 'user', parts: [{ text: userPrompt }] })

  return { systemInstruction, contents }
}
