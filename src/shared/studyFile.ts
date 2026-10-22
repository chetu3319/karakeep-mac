/**
 * The saved form of a Study chat: one self-contained HTML file, attached to the
 * bookmark in Karakeep. It has two audiences, so it carries two copies:
 *
 *  - a readable transcript, for anyone who opens the attachment in Karakeep's
 *    web app (it is just a web page);
 *  - the thread as JSON in a <script type="application/json"> block, which is
 *    what this app reads back.
 *
 * Everything here runs in main as well as the renderer, and main has no
 * DOMParser, so parsing is a regex over the JSON block plus hand validation.
 * Message text is model and page content: it is HTML-escaped in the
 * transcript, and `<` is escaped inside the JSON so no message can close the
 * script block early.
 */
import {
  STUDY_SCHEMA_VERSION,
  stripForPersistence,
  type StudyAttachment,
  type StudyMessage,
  type StudyThread
} from './study'

export type ParsedStudyFile =
  | { status: 'ok'; thread: StudyThread }
  | { status: 'newer'; v: number }
  | { status: 'invalid' }

const JSON_BLOCK = /<script type="application\/json" id="kk-study">([\s\S]*?)<\/script>/

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Model text with `[[ref ...]]` markers shown as “quote” (p.4); other text escaped. */
function transcriptHtml(text: string): string {
  const marker = /\[\[ref((?:\s+(?:fig|p=\d+))*)\s+"([\s\S]*?)"\s*\]\]/g
  let out = ''
  let last = 0
  for (const m of text.matchAll(marker)) {
    out += esc(text.slice(last, m.index))
    const page = /p=(\d+)/.exec(m[1])
    out += esc(`“${m[2].trim()}”${page ? ` (p.${page[1]})` : ''}`)
    last = m.index! + m[0].length
  }
  out += esc(text.slice(last))
  // Anything still looking like a marker is malformed: do not show it raw.
  return out.replace(/\[\[ref[\s\S]*?(\]\]|$)/g, '').replace(/\n/g, '<br>')
}

function attachmentHtml(a: StudyAttachment): string {
  const page = a.page !== undefined ? ` (p.${a.page})` : ''
  const body = a.kind === 'text' ? `“${a.quote}”${page}` : `${a.label}${page}`
  return `<blockquote>${esc(body)}</blockquote>`
}

function messageHtml(m: StudyMessage): string {
  const who = m.role === 'user' ? 'You' : 'Study'
  const att = (m.attachments ?? []).map(attachmentHtml).join('')
  return `<section class="${m.role}"><h2>${who}</h2>${att}<p>${transcriptHtml(m.text)}</p></section>`
}

export function renderStudyHtml(thread: StudyThread, docTitle: string): string {
  const clean = stripForPersistence(thread)
  // `<` as < keeps "</script>" (and "<!--") inert inside the block.
  const json = JSON.stringify(clean).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(docTitle)} - Study</title>
<style>
body{font:15px/1.55 -apple-system,system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}
h1{font-size:1.25rem}
h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;opacity:.6;margin:1.5rem 0 .25rem}
section.user p{opacity:.85}
blockquote{margin:.25rem 0;padding-left:.75rem;border-left:3px solid #10b981;opacity:.8}
p{margin:.25rem 0}
</style>
</head>
<body>
<h1>${esc(docTitle)}</h1>
${clean.messages.map(messageHtml).join('\n')}
<script type="application/json" id="kk-study">${json}</script>
</body>
</html>
`
}

const isStr = (x: unknown): x is string => typeof x === 'string'
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const optNum = (x: unknown) => x === undefined || isNum(x)
const optStr = (x: unknown) => x === undefined || isStr(x)

function validAttachment(a: unknown): a is StudyAttachment {
  if (!a || typeof a !== 'object') return false
  const o = a as Record<string, unknown>
  if (o.kind === 'text') return isStr(o.quote) && optNum(o.page) && optStr(o.context)
  if (o.kind === 'region') {
    const r = o.rect as Record<string, unknown> | undefined
    return (
      isStr(o.label) &&
      optNum(o.page) &&
      optStr(o.text) &&
      !!r &&
      isNum(r.x) &&
      isNum(r.y) &&
      isNum(r.width) &&
      isNum(r.height)
    )
  }
  return false
}

function validMessage(m: unknown): m is StudyMessage {
  if (!m || typeof m !== 'object') return false
  const o = m as Record<string, unknown>
  return (
    isStr(o.id) &&
    (o.role === 'user' || o.role === 'model') &&
    isStr(o.text) &&
    isStr(o.createdAt) &&
    (o.attachments === undefined ||
      (Array.isArray(o.attachments) && o.attachments.every(validAttachment)))
  )
}

export function parseStudyHtml(html: string): ParsedStudyFile {
  const m = JSON_BLOCK.exec(html)
  if (!m) return { status: 'invalid' }

  let data: unknown
  try {
    data = JSON.parse(m[1])
  } catch {
    return { status: 'invalid' }
  }
  if (!data || typeof data !== 'object') return { status: 'invalid' }
  const o = data as Record<string, unknown>

  if (!isNum(o.v)) return { status: 'invalid' }
  // A newer app wrote this; do not guess at its shape (or overwrite it).
  if (o.v > STUDY_SCHEMA_VERSION) return { status: 'newer', v: o.v }

  if (
    !isStr(o.bookmarkId) ||
    !isStr(o.updatedAt) ||
    !Array.isArray(o.messages) ||
    !o.messages.every(validMessage)
  ) {
    return { status: 'invalid' }
  }
  return {
    status: 'ok',
    thread: { v: o.v, bookmarkId: o.bookmarkId, updatedAt: o.updatedAt, messages: o.messages }
  }
}
