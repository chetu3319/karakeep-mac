import { net } from 'electron'
import { getResolvedAiConfig, setAiConfig } from './store'
import type { AiStreamRequest, AiTestResult } from '../shared/types'
import { buildPromptPayload } from './aiPrompt'

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
    case 'custom':
      return 'low'
    case 'study':
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
    case 'custom':
      return 2048
    case 'study':
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
      const { systemInstruction, contents } = buildPromptPayload(req)

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
        const error = new Error(message) as Error & { code?: 'too-large' }
        // Study sends the whole document, so the one failure the caller can
        // act on is "too big": it retries once at half the budget.
        if (res.status === 400 && /token|context|too (long|large)|exceed/i.test(message)) {
          error.code = 'too-large'
        }
        throw error
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
}

export const aiService = new GeminiAiService()
