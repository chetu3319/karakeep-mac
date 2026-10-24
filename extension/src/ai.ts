/**
 * Inline AI answers for the selection toolbar, streamed from Gemini.
 *
 * Prompt assembly is shared with the desktop app (src/main/aiPrompt.ts), so
 * "Explain" and "Ask…" answer the same way in the browser as in the reader.
 * The request is the one src/main/ai.ts sends, on plain fetch.
 */
import { buildPromptPayload } from '../../src/main/aiPrompt'
import type { AiStreamRequest } from '../../src/shared/types'
import type { Settings } from './settings'

// The selection modes answer without pulling the reader out of flow, so they
// run at the lowest thinking level, with headroom for thinking tokens inside
// the output budget (see the same choice in src/main/ai.ts).
const THINKING_LEVEL = 'low'
const MAX_OUTPUT_TOKENS = 2048

function geminiError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    if (parsed.error?.message) return parsed.error.message
  } catch {
    // not JSON
  }
  return `Gemini API error (${status})`
}

export async function testGemini(settings: Settings): Promise<{ ok: boolean; error?: string; model?: string }> {
  if (!settings.geminiApiKey) return { ok: false, error: 'Enter a Gemini API key first.' }
  const model = settings.geminiModel
  try {
    const res = await fetch(`${settings.geminiEndpoint}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiApiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Respond with "ok"' }] }],
        generationConfig: { maxOutputTokens: 10 }
      })
    })
    if (!res.ok) return { ok: false, error: geminiError(res.status, await res.text()) }
    return { ok: true, model }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Streams one answer, calling `onChunk` per text delta; resolves with the full text. */
export async function streamAnswer(
  settings: Settings,
  req: AiStreamRequest,
  onChunk: (delta: string) => void,
  signal: AbortSignal
): Promise<string> {
  if (!settings.geminiApiKey) {
    throw new Error('AI answers need a Gemini API key. Add one in the Karakeep extension settings.')
  }
  const { systemInstruction, contents } = buildPromptPayload(req)
  const url = `${settings.geminiEndpoint}/models/${encodeURIComponent(settings.geminiModel)}:streamGenerateContent?alt=sse`
  const res = await fetch(url, {
    method: 'POST',
    // The key travels as a header, never as a `?key=` query parameter.
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiApiKey },
    signal,
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: { thinkingConfig: { thinkingLevel: THINKING_LEVEL }, maxOutputTokens: MAX_OUTPUT_TOKENS }
    })
  })
  if (!res.ok) throw new Error(geminiError(res.status, await res.text()))
  if (!res.body) throw new Error('No response body from Gemini API')

  let full = ''
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
      const json = trimmed.slice(6).trim()
      if (!json || json === '[DONE]') continue
      try {
        const data = JSON.parse(json)
        if (data.promptFeedback?.blockReason) blockReason = data.promptFeedback.blockReason
        const candidate = data.candidates?.[0]
        if (candidate?.finishReason) finishReason = candidate.finishReason
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text) {
            full += part.text
            onChunk(part.text)
          }
        }
      } catch {
        // partial JSON in the stream
      }
    }
  }

  // A response with no text at all is turned into a real error rather than
  // a silently blank card.
  if (!full) {
    if (blockReason) throw new Error(`Gemini blocked this request (${blockReason}). Try a different selection.`)
    if (finishReason === 'MAX_TOKENS') throw new Error('Gemini ran out of its output budget. Try a shorter selection.')
    if (finishReason && finishReason !== 'STOP') throw new Error(`Gemini returned no text (${finishReason}).`)
    throw new Error('Gemini returned an empty response.')
  }
  return full
}
