// A stand-in Karakeep server for the extension's end-to-end run: an in-memory
// implementation of exactly the /api/v1 endpoints the extension calls, shaped
// like the real responses (see BRIEF.md and the OpenAPI spec), plus a
// Gemini-compatible streaming stub and two sample article sites on another
// origin.
import http from 'node:http'
import { randomUUID } from 'node:crypto'

export const API_KEY = 'kk_e2e_test_key'

const now = () => new Date().toISOString()
const id = () => randomUUID().replace(/-/g, '').slice(0, 24)

export function createState(sitesOrigin) {
  const tags = [
    { id: 't-research', name: 'research' },
    { id: 't-reading', name: 'reading' },
    { id: 't-attention', name: 'attention' },
    { id: 't-design', name: 'design' }
  ]
  const lists = [
    { id: 'l-reading', name: 'Reading queue', icon: '📚', parentId: null, type: 'manual' },
    { id: 'l-ml', name: 'ML papers', icon: '🧠', parentId: null, type: 'manual' },
    { id: 'l-fav', name: 'Favourites', icon: '⭐', parentId: null, type: 'smart', query: 'is:fav' }
  ]
  const savedUrl = `${sitesOrigin}/articles/deep-reading`
  const bookmarks = [
    {
      id: 'bm-deep-reading',
      createdAt: '2026-10-20T09:12:00.000Z',
      modifiedAt: '2026-10-20T09:12:00.000Z',
      title: null,
      archived: false,
      favourited: true,
      taggingStatus: 'success',
      summarizationStatus: null,
      note: 'Good framing for the reading-tools essay. Compare with the Wolf book.',
      summary: null,
      source: 'web',
      userId: 'u-demo',
      tags: [tags[0], tags[1]].map((t) => ({ ...t, attachedBy: 'human' })),
      content: {
        type: 'link',
        url: savedUrl,
        title: 'The Case for Reading Slowly',
        description: 'Why deep reading is a skill, and how tools can protect it.',
        favicon: `${sitesOrigin}/favicon.svg`,
        crawlStatus: 'success'
      },
      assets: []
    }
  ]
  const membership = new Map([['bm-deep-reading', new Set(['l-reading'])]])
  const highlights = [
    {
      id: 'hl-1',
      bookmarkId: 'bm-deep-reading',
      startOffset: 320,
      endOffset: 420,
      color: 'yellow',
      text: 'Deep reading is not a natural gift but a circuit the brain builds, slowly, through years of practice',
      note: '',
      userId: 'u-demo',
      createdAt: '2026-10-20T09:15:00.000Z'
    },
    {
      id: 'hl-2',
      bookmarkId: 'bm-deep-reading',
      startOffset: 900,
      endOffset: 1000,
      color: 'green',
      text: 'the medium trains the reader as much as the reader uses the medium',
      note: 'This is the core claim. Tools that interrupt reading are not neutral; they rewire what we can attend to.',
      userId: 'u-demo',
      createdAt: '2026-10-20T09:17:00.000Z'
    },
    {
      id: 'hl-3',
      bookmarkId: 'bm-deep-reading',
      startOffset: 1600,
      endOffset: 1700,
      color: 'blue',
      text: 'An annotation is a conversation with your future self',
      note: '',
      userId: 'u-demo',
      createdAt: '2026-10-20T09:20:00.000Z'
    }
  ]
  return { tags, lists, bookmarks, membership, highlights, log: [] }
}

const normalizeUrl = (u) => {
  try {
    const url = new URL(u)
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return u
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : undefined
}

const GEMINI_ANSWER = [
  'Here the author is saying that ',
  '**the tools we read with shape the kind of reader we become**. ',
  'A medium that constantly interrupts (notifications, pop-ups, endless links) trains short, skimming attention, ',
  'while one that stays out of the way lets the slower, deeper reading circuit keep developing.'
]

export function startMockServer({ apiPort, sitesPort, sitesHtml }) {
  const sitesOrigin = `http://127.0.0.1:${sitesPort}`
  const state = createState(sitesOrigin)

  const api = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${apiPort}`)
    const path = url.pathname
    const method = req.method

    // ── Gemini stub ──
    if (path.startsWith('/gemini/')) {
      const body = await readBody(req)
      state.log.push({ method, path: '/gemini', body })
      if (req.headers['x-goog-api-key'] !== 'AIza-e2e') return json(res, 400, { error: { message: 'API key not valid.' } })
      if (path.endsWith(':generateContent')) {
        return json(res, 200, { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const [i, text] of GEMINI_ANSWER.entries()) {
        const last = i === GEMINI_ANSWER.length - 1
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...(last ? { finishReason: 'STOP' } : {}) }] })}\n\n`)
        await new Promise((r) => setTimeout(r, 120))
      }
      return res.end()
    }

    if (!path.startsWith('/api/v1/')) return json(res, 404, { error: 'not found' })
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'text/plain' })
      return res.end('Unauthorized')
    }
    const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? await readBody(req) : undefined
    state.log.push({ method, path, body })
    const p = path.slice('/api/v1'.length)
    const seg = p.split('/').filter(Boolean)
    const findBm = (bid) => state.bookmarks.find((b) => b.id === bid)

    if (p === '/users/me') return json(res, 200, { id: 'u-demo', name: 'Demo Reader', email: 'demo@example.com', image: null })

    if (p === '/bookmarks/check-url' && method === 'GET') {
      const target = normalizeUrl(url.searchParams.get('url') || '')
      const hit = state.bookmarks.find((b) => normalizeUrl(b.content?.url || '') === target)
      return json(res, 200, { bookmarkId: hit ? hit.id : null })
    }

    if (p === '/bookmarks' && method === 'POST') {
      const existing = state.bookmarks.find((b) => normalizeUrl(b.content?.url || '') === normalizeUrl(body.url))
      if (existing) return json(res, 200, existing)
      const bm = {
        id: `bm-${id()}`,
        createdAt: now(),
        modifiedAt: now(),
        title: body.title ?? null,
        archived: false,
        favourited: false,
        taggingStatus: 'pending',
        note: null,
        summary: null,
        source: body.source ?? 'api',
        userId: 'u-demo',
        tags: [],
        content: { type: 'link', url: body.url, title: body.title ?? null, crawlStatus: 'pending' },
        assets: []
      }
      state.bookmarks.push(bm)
      return json(res, 201, bm)
    }

    if (seg[0] === 'bookmarks' && seg.length >= 2) {
      const bm = findBm(seg[1])
      if (!bm) return json(res, 404, { code: 'NOT_FOUND', message: 'Bookmark not found' })
      if (seg.length === 2) {
        if (method === 'GET') return json(res, 200, bm)
        if (method === 'PATCH') {
          Object.assign(bm, body, { modifiedAt: now() })
          return json(res, 200, bm)
        }
        if (method === 'DELETE') {
          state.bookmarks = state.bookmarks.filter((b) => b !== bm)
          state.highlights = state.highlights.filter((h) => h.bookmarkId !== bm.id)
          res.writeHead(204)
          return res.end()
        }
      }
      if (seg[2] === 'highlights') {
        return json(res, 200, { highlights: state.highlights.filter((h) => h.bookmarkId === bm.id), nextCursor: null })
      }
      if (seg[2] === 'lists') {
        const ids = state.membership.get(bm.id) || new Set()
        return json(res, 200, { lists: state.lists.filter((l) => ids.has(l.id)) })
      }
      if (seg[2] === 'tags') {
        const names = body.tags.map((t) => t.tagName)
        if (method === 'POST') {
          for (const name of names) {
            let tag = state.tags.find((t) => t.name === name)
            if (!tag) state.tags.push((tag = { id: `t-${id()}`, name }))
            if (!bm.tags.some((t) => t.id === tag.id)) bm.tags.push({ ...tag, attachedBy: 'human' })
          }
          return json(res, 200, { attached: names })
        }
        bm.tags = bm.tags.filter((t) => !names.includes(t.name))
        return json(res, 200, { detached: names })
      }
    }

    if (p === '/tags') return json(res, 200, { tags: state.tags.map((t) => ({ ...t, numBookmarks: 1 })) })
    if (p === '/lists') return json(res, 200, { lists: state.lists })

    if (seg[0] === 'lists' && seg[2] === 'bookmarks' && seg[3]) {
      const set = state.membership.get(seg[3]) || new Set()
      state.membership.set(seg[3], set)
      if (method === 'PUT') set.add(seg[1])
      else set.delete(seg[1])
      res.writeHead(204)
      return res.end()
    }

    if (p === '/highlights' && method === 'POST') {
      if (!['yellow', 'red', 'green', 'blue'].includes(body.color)) return json(res, 400, { error: 'bad color' })
      if (body.note === undefined) return json(res, 400, { error: 'note required' })
      if (!findBm(body.bookmarkId)) return json(res, 404, { error: 'bookmark not found' })
      const hl = { id: `hl-${id()}`, ...body, userId: 'u-demo', createdAt: now() }
      state.highlights.push(hl)
      return json(res, 201, hl)
    }
    if (seg[0] === 'highlights' && seg[1]) {
      const hl = state.highlights.find((h) => h.id === seg[1])
      if (!hl) return json(res, 404, { error: 'highlight not found' })
      if (method === 'PATCH') {
        Object.assign(hl, body)
        return json(res, 200, hl)
      }
      if (method === 'DELETE') {
        state.highlights = state.highlights.filter((h) => h !== hl)
        return json(res, 200, hl)
      }
    }

    return json(res, 404, { error: `no mock for ${method} ${p}` })
  })

  const sites = http.createServer((req, res) => {
    const path = new URL(req.url, sitesOrigin).pathname
    if (path === '/favicon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
      return res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f2937"/><text x="16" y="22" font-size="17" text-anchor="middle" fill="#fbbf24" font-family="Georgia">L</text></svg>'
      )
    }
    const html = sitesHtml[path]
    if (!html) {
      res.writeHead(404)
      return res.end('not found')
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })

  return new Promise((resolve) => {
    api.listen(apiPort, '127.0.0.1', () =>
      sites.listen(sitesPort, '127.0.0.1', () =>
        resolve({ state: () => state, sitesOrigin, close: () => (api.close(), sites.close()) })
      )
    )
  })
}
