import type { StudyAttachment, StudyMessage } from './study'

/** The four quick actions the selection toolbar offers. */
export type InlineMode = 'micro-explain' | 'micro-define' | 'micro-formula' | 'custom'

const MODE_LABEL: Record<Exclude<InlineMode, 'custom'>, string> = {
  'micro-explain': 'Explain',
  'micro-define': 'Define',
  'micro-formula': 'Math'
}

/** What the user "said" in the Study thread for this quick answer. */
export function inlineQuestionText(mode: InlineMode, prompt?: string): string {
  if (mode === 'custom') return (prompt ?? '').trim()
  return MODE_LABEL[mode]
}

/** The selection as a Study chip. `page` is 1-based. */
export function textAttachment(quote: string, page?: number, context?: string): StudyAttachment {
  return {
    kind: 'text',
    quote,
    ...(page !== undefined ? { page } : {}),
    ...(context ? { context } : {})
  }
}

/**
 * The two turns "Continue in Study" seeds: the question with the selection
 * attached, then the answer the reader already saw.
 */
export function buildContinueMessages(opts: {
  mode: InlineMode
  prompt?: string
  answer: string
  attachment: StudyAttachment
  now?: Date
  newId?: () => string
}): StudyMessage[] {
  const newId = opts.newId ?? ((): string => `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const createdAt = (opts.now ?? new Date()).toISOString()
  return [
    {
      id: newId(),
      role: 'user',
      text: inlineQuestionText(opts.mode, opts.prompt),
      attachments: [opts.attachment],
      createdAt
    },
    { id: newId(), role: 'model', text: opts.answer, createdAt }
  ]
}
