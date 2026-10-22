import type { StudyAttachment, StudyMessage } from './study'

/**
 * Validation for Study payloads that arrive from a web page's preload. That
 * script runs next to untrusted page code, so main keeps only the fields and
 * types it expects, and caps every string, before forwarding to the renderer.
 */
const MAX_QUOTE = 10_000
const MAX_CONTEXT = 20_000
const MAX_TEXT = 30_000
const MAX_ID = 100
const MAX_MESSAGES = 4

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null
}

export function sanitizeStudyAttachment(raw: unknown): StudyAttachment | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind !== 'text') return null
  const quote = str(r.quote, MAX_QUOTE)
  if (!quote || !quote.trim()) return null
  const context = str(r.context, MAX_CONTEXT)
  return { kind: 'text', quote, ...(context ? { context } : {}) }
}

export function sanitizeStudyMessages(raw: unknown): StudyMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null
  const out: StudyMessage[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const m = item as Record<string, unknown>
    if (m.role !== 'user' && m.role !== 'model') return null
    const id = str(m.id, MAX_ID)
    const text = str(m.text, MAX_TEXT)
    const createdAt = str(m.createdAt, MAX_ID)
    if (!id || text === null || !createdAt) return null
    const attachments: StudyAttachment[] = []
    if (Array.isArray(m.attachments)) {
      for (const a of m.attachments.slice(0, 4)) {
        const clean = sanitizeStudyAttachment(a)
        if (clean) attachments.push(clean)
      }
    }
    out.push({ id, role: m.role, text, ...(attachments.length ? { attachments } : {}), createdAt })
  }
  return out
}
