import { getResolvedAiConfig, setAiConfig } from './store'
import type { AiStreamRequest, AiTestResult } from '../shared/types'

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
    const model = customModel || resolved?.geminiModel || 'gemini-2.5-flash'

    if (!apiKey) {
      return { ok: false, error: 'No Gemini API key configured. Please enter your API key in Settings.' }
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const { systemInstruction, userPrompt, contents } = this.buildPromptPayload(req)

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents,
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          generationConfig: {
            temperature: req.mode === 'micro-formula' ? 0.1 : 0.25,
            maxOutputTokens: req.mode === 'micro-dejargon' ? 1024 : 2048
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
            const candidate = data.candidates?.[0]
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
    let systemInstruction =
      'You are an expert AI research co-pilot integrated directly into a flow-preserving document reader. ' +
      'Your goal is to maintain the reader\'s deep flow state and comprehension. ' +
      'Be direct, crisp, and intellectually rigorous. Use clear formatting and bullet points where helpful. Avoid generic fluff.'

    const contextSnippets: string[] = []
    if (req.docTitle) {
      contextSnippets.push(`Document Title: "${req.docTitle}"`)
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
          '\nTask: De-jargon and simplify the selected text. Rewrite it in plain, crystal-clear English while strictly preserving technical precision. Return the concise plain-English explanation immediately.'
        userPrompt = `${contextSnippets.join('\n\n')}\n\nSelected Text to Simplify:\n"${req.selectionText || ''}"`
        break

      case 'micro-explain':
        systemInstruction +=
          '\nTask: Define and explain the highlighted term or concept strictly in the context of this paper. Explain what it means here, why the authors use it, and how it connects to the method. Keep it under 3-4 sentences.'
        userPrompt = `${contextSnippets.join('\n\n')}\n\nSelected Concept/Term to Explain:\n"${req.selectionText || ''}"`
        break

      case 'micro-formula':
        systemInstruction +=
          '\nTask: Mathematical and formula breakdown. Unpack the mathematical notation step-by-step:\n1. Core intuition (what is this computing?)\n2. Variable breakdown (what each symbol represents)\n3. Why this formula is used here in the paper.'
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
