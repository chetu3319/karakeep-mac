import { net } from 'electron'
import { getResolvedAiConfig, setAiConfig } from './store'
import type { AiStreamRequest, AiTestResult } from '../shared/types'

// Gemini 3.x generation config is a breaking change from 2.5: `temperature`,
// `topP`, `topK` and `candidateCount` are deprecated/unsupported on the 3.x
// family, and `thinkingBudget` (a token count) is replaced by the string
// enum `thinkingLevel`. Sending the old fields isn't rejected outright, but
// it's dead weight that no longer does anything — better to name only what
// the API actually reads. See Google's Gemini 3.x migration guide.
type ThinkingLevel = 'low' | 'medium' | 'high'

/**
 * The in-situ modes (Explain/Dejargonify/Define/Math) exist specifically to
 * answer *without* pulling the reader out of flow — that's the whole design
 * goal of that surface (see BRIEF's product spec). A "high" or even
 * "medium" thinking budget adds seconds of latency before the first token,
 * which defeats the purpose. The sidebar chat and page-level modes have no
 * such constraint and benefit from the deeper reasoning "medium" buys.
 */
function thinkingLevelFor(mode: AiStreamRequest['mode']): ThinkingLevel {
  switch (mode) {
    case 'micro-explain':
    case 'micro-dejargon':
    case 'micro-define':
    case 'micro-formula':
      return 'low'
    default:
      return 'medium'
  }
}

/**
 * On a thinking model, tokens spent thinking are deducted from the same
 * `maxOutputTokens` budget as the visible answer — they are not a separate
 * allowance. A cap sized only for the answer text (the old 1024 for
 * micro-dejargon) can be entirely consumed by thinking, producing a
 * candidate with zero output text and no error of its own. These numbers
 * leave real headroom for thinking *and* an answer.
 */
function maxOutputTokensFor(mode: AiStreamRequest['mode']): number {
  switch (mode) {
    case 'micro-explain':
    case 'micro-dejargon':
    case 'micro-define':
    case 'micro-formula':
      return 2048
    default:
      return 8192
  }
}

export class GeminiAiService {
  private activeStreams = new Map<string, AbortController>()

  abort(requestId: string): void {
    const controller = this.activeStreams.get(requestId)
    if (controller) {
      controller.abort()
      this.activeStreams.delete(requestId)
    }
  }

  async testConnection(customApiKey?: string, customModel?: string): Promise<AiTestResult> {
    const resolved = getResolvedAiConfig()
    const apiKey = customApiKey || resolved?.geminiApiKey
    const model = customModel || resolved?.geminiModel || 'gemini-3.7-flash'

    if (!apiKey) {
      return { ok: false, error: 'No Gemini API key configured. Please enter your API key in Settings.' }
    }

    try {
      // The key travels as a header, not a `?key=` query parameter — query
      // strings are the part of a URL that ends up verbatim in proxy logs,
      // crash reports, and dev-tools network panels, none of which should
      // ever see a live credential.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
      // net.fetch, not global fetch — see the note in api.ts. A corporate
      // SSL-inspection proxy breaks Gemini exactly the way it breaks the
      // Karakeep API, so both have to ride the Chromium stack.
      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Respond with "ok"' }] }],
          generationConfig: { maxOutputTokens: 10 }
        })
      })

      if (!res.ok) {
        const errorText = await res.text()
        let message = `Gemini API error (${res.status})`
        try {
          const parsed = JSON.parse(errorText)
          if (parsed.error?.message) message = parsed.error.message
        } catch {
          // ignore
        }
        return { ok: false, error: message }
      }

      return { ok: true, model }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async streamRequest(
    req: AiStreamRequest,
    onChunk: (delta: string) => void
  ): Promise<string> {
    const resolved = getResolvedAiConfig()
    if (!resolved?.geminiApiKey) {
      throw new Error('Gemini API key is not configured. Please add your key in Settings.')
    }

    const { geminiApiKey: apiKey, geminiModel: model } = resolved

    // Cancel any existing stream with this ID
    this.abort(req.requestId)

    const controller = new AbortController()
    this.activeStreams.set(req.requestId, controller)

    try {
      const { systemInstruction, contents } = this.buildPromptPayload(req)

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`

      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          contents,
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          generationConfig: {
            thinkingConfig: { thinkingLevel: thinkingLevelFor(req.mode) },
            maxOutputTokens: maxOutputTokensFor(req.mode)
          }
        })
      })

      if (!res.ok) {
        const errorText = await res.text()
        let message = `Gemini API error (${res.status})`
        try {
          const parsed = JSON.parse(errorText)
          if (parsed.error?.message) message = parsed.error.message
        } catch {
          // ignore
        }
        throw new Error(message)
      }

      if (!res.body) {
        throw new Error('No response body from Gemini API')
      }

      let fullAccumulatedText = ''
      // Tracked across the whole stream so a response that never produced
      // any text — blocked by a safety filter, cut off by the token budget,
      // or something the API declined to explain — can still be turned into
      // a real error instead of a silently blank panel. See the check after
      // the read loop.
      let blockReason: string | null = null
      let finishReason: string | null = null
      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue

          const jsonStr = trimmed.slice(6).trim()
          if (!jsonStr || jsonStr === '[DONE]') continue

          try {
            const data = JSON.parse(jsonStr)
            if (data.promptFeedback?.blockReason) {
              blockReason = data.promptFeedback.blockReason
            }
            const candidate = data.candidates?.[0]
            if (candidate?.finishReason) {
              finishReason = candidate.finishReason
            }
            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.text) {
                  fullAccumulatedText += part.text
                  onChunk(part.text)
                }
              }
            }
          } catch {
            // ignore partial JSON parse errors in stream
          }
        }
      }

      if (!fullAccumulatedText) {
        if (blockReason) {
          throw new Error(`Gemini blocked this request (${blockReason}). Try rephrasing or selecting different text.`)
        }
        if (finishReason && finishReason !== 'STOP') {
          if (finishReason === 'MAX_TOKENS') {
            throw new Error('Gemini ran out of its output budget before writing an answer (MAX_TOKENS). Try a shorter selection.')
          }
          if (finishReason === 'SAFETY') {
            throw new Error('Gemini declined to answer for safety reasons (SAFETY).')
          }
          if (finishReason === 'RECITATION') {
            throw new Error('Gemini declined to answer because the response too closely matched existing text (RECITATION).')
          }
          throw new Error(`Gemini returned no text (${finishReason}).`)
        }
        throw new Error('Gemini returned an empty response for an unknown reason.')
      }

      return fullAccumulatedText
    } finally {
      this.activeStreams.delete(req.requestId)
    }
  }

  private buildPromptPayload(req: AiStreamRequest): {
    systemInstruction: string
    userPrompt: string
    contents: Array<{ role: string; parts: Array<{ text: string }> }>
  } {
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
      case 'micro-dejargon':
        systemInstruction +=
          `\nTask: De-jargon and simplify the selected text from this ${noun}. Rewrite it in plain, crystal-clear English while strictly preserving technical precision. Return the concise plain-English explanation immediately.`
        userPrompt = `${contextSnippets.join('\n\n')}\n\nSelected Text to Simplify:\n"${req.selectionText || ''}"`
        break

      case 'micro-explain':
        systemInstruction +=
          `\nTask: Explain the selected text strictly in the context of this ${noun}: what it means here, why ${authorNoun} say it, and how it connects to the surrounding argument. Keep it under 3-4 sentences.`
        userPrompt = `${contextSnippets.join('\n\n')}\n\nSelected Text to Explain:\n"${req.selectionText || ''}"`
        break

      case 'micro-define':
        systemInstruction +=
          `\nTask: Give a tight definition of the highlighted term. Cover both its general meaning and, if different, the specific sense it carries in this ${noun}. Keep it under 2-3 sentences.`
        userPrompt = `${contextSnippets.join('\n\n')}\n\nTerm to Define:\n"${req.selectionText || ''}"`
        break

      case 'micro-formula':
        systemInstruction +=
          `\nTask: Mathematical and formula breakdown. Unpack the mathematical notation step-by-step:\n1. Core intuition (what is this computing?)\n2. Variable breakdown (what each symbol represents)\n3. Why this formula is used here in the ${noun}.`
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

    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = []

    // Append prior chat history if provided
    if (req.history && req.history.length > 0) {
      for (const h of req.history) {
        contents.push({
          role: h.role === 'user' ? 'user' : 'model',
          parts: [{ text: h.text }]
        })
      }
    }

    contents.push({
      role: 'user',
      parts: [{ text: userPrompt }]
    })

    return { systemInstruction, userPrompt, contents }
  }
}

export const aiService = new GeminiAiService()
