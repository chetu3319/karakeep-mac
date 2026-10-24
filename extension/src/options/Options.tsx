import React, { useEffect, useState } from 'react'
import type { User } from '../../../src/shared/types'
import { send } from '../messages'
import {
  DEFAULT_GEMINI_MODEL,
  formatHeaderLines,
  getSettings,
  normalizeBaseUrl,
  parseHeaderLines,
  saveSettings
} from '../settings'

const field =
  'w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-neutral-700'
const label = 'mb-1 block text-neutral-600 dark:text-neutral-400'
const primary =
  'shrink-0 whitespace-nowrap rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200'
const secondary =
  'shrink-0 whitespace-nowrap rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800'

const isMac = /Mac/i.test(navigator.platform)

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type Status = { kind: 'ok' | 'error'; text: string } | null

function StatusLine({ status }: { status: Status }): React.JSX.Element | null {
  if (!status) return null
  return (
    <p className={`text-sm ${status.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
      {status.text}
    </p>
  )
}

function Card({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <h2 className="mb-1 text-base font-semibold">{title}</h2>
      <p className="mb-5 text-sm text-neutral-500">{subtitle}</p>
      {children}
    </section>
  )
}

export default function Options(): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showHeaders, setShowHeaders] = useState(false)
  const [headersText, setHeadersText] = useState('')
  const [serverStatus, setServerStatus] = useState<Status>(null)
  const [busy, setBusy] = useState(false)

  const [geminiKey, setGeminiKey] = useState('')
  const [geminiModel, setGeminiModel] = useState(DEFAULT_GEMINI_MODEL)
  const [aiStatus, setAiStatus] = useState<Status>(null)
  const [aiBusy, setAiBusy] = useState(false)

  const [showHighlights, setShowHighlights] = useState(true)

  useEffect(() => {
    void getSettings().then((s) => {
      setBaseUrl(s.baseUrl)
      setApiKey(s.apiKey)
      setHeadersText(formatHeaderLines(s.customHeaders))
      setShowHeaders(Object.keys(s.customHeaders).length > 0)
      setGeminiKey(s.geminiApiKey)
      setGeminiModel(s.geminiModel)
      setShowHighlights(s.showHighlights)
      setLoaded(true)
      if (s.baseUrl && s.apiKey) {
        send<User>({ type: 'config:test', baseUrl: s.baseUrl, apiKey: s.apiKey, customHeaders: s.customHeaders }).then(
          (u) => setServerStatus({ kind: 'ok', text: `Signed in as ${u.name || u.email}` }),
          (err) => setServerStatus({ kind: 'error', text: errMessage(err) })
        )
      }
    })
  }, [])

  async function connect(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setServerStatus(null)
    const url = normalizeBaseUrl(baseUrl)
    const customHeaders = parseHeaderLines(headersText)
    try {
      // Saved only once the server has accepted the key, so a typo never
      // replaces a working configuration.
      const user = await send<User>({ type: 'config:test', baseUrl: url, apiKey: apiKey.trim(), customHeaders })
      await saveSettings({ baseUrl: url, apiKey: apiKey.trim(), customHeaders })
      setBaseUrl(url)
      setServerStatus({ kind: 'ok', text: `Signed in as ${user.name || user.email}` })
    } catch (err) {
      setServerStatus({ kind: 'error', text: errMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  async function saveAi(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setAiBusy(true)
    setAiStatus(null)
    const model = geminiModel.trim() || DEFAULT_GEMINI_MODEL
    try {
      if (geminiKey.trim()) {
        await send<string>({ type: 'ai:test', geminiApiKey: geminiKey.trim(), geminiModel: model })
      }
      await saveSettings({ geminiApiKey: geminiKey.trim(), geminiModel: model })
      setAiStatus({ kind: 'ok', text: geminiKey.trim() ? `Connected to ${model}` : 'AI answers turned off' })
    } catch (err) {
      setAiStatus({ kind: 'error', text: errMessage(err) })
    } finally {
      setAiBusy(false)
    }
  }

  async function toggleHighlights(next: boolean): Promise<void> {
    setShowHighlights(next)
    await saveSettings({ showHighlights: next })
  }

  if (!loaded) return <div />

  return (
    <div className="mx-auto max-w-xl space-y-6 px-4 py-10">
      <div className="flex items-center gap-3">
        <img src="icons/icon-48.png" alt="" className="h-9 w-9 rounded-lg" />
        <div>
          <h1 className="text-xl font-semibold">Karakeep for Chrome</h1>
          <p className="text-sm text-neutral-500">Save pages, highlight and annotate them, right in the tab.</p>
        </div>
      </div>

      <Card title="Connect to Karakeep" subtitle="Sign in to your self-hosted Karakeep server.">
        <form onSubmit={connect} className="space-y-3">
          <label className="block text-sm">
            <span className={label}>Server URL</span>
            <input className={field} placeholder="http://localhost:3000" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
          </label>
          <label className="block text-sm">
            <span className={label}>API key</span>
            <input type="password" className={field} placeholder="kk_..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
            <span className="mt-1 block text-xs text-neutral-400">Create one in Karakeep under Settings → API keys.</span>
          </label>
          <button
            type="button"
            className="text-xs text-neutral-500 underline underline-offset-2"
            onClick={() => setShowHeaders((s) => !s)}
          >
            {showHeaders ? 'Hide' : 'Add'} custom headers
          </button>
          {showHeaders && (
            <textarea
              className={`${field} font-mono text-xs`}
              placeholder={'X-Custom-Header: value\nAnother-Header: value'}
              rows={3}
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
            />
          )}
          <div className="flex items-center gap-3 pt-1">
            <button type="submit" disabled={busy} className={primary}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <StatusLine status={serverStatus} />
          </div>
        </form>
      </Card>

      <Card
        title="AI answers"
        subtitle="Explain and Ask… in the highlight toolbar use Google Gemini with your own API key, the same as the desktop app."
      >
        <form onSubmit={saveAi} className="space-y-3">
          <label className="block text-sm">
            <span className={label}>Gemini API key</span>
            <input type="password" className={field} placeholder="AIza..." value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className={label}>Model</span>
            <input className={field} value={geminiModel} onChange={(e) => setGeminiModel(e.target.value)} />
          </label>
          <div className="flex items-center gap-3 pt-1">
            <button type="submit" disabled={aiBusy} className={secondary}>
              {aiBusy ? 'Testing…' : 'Save'}
            </button>
            <StatusLine status={aiStatus} />
          </div>
        </form>
      </Card>

      <Card title="Highlights" subtitle="How highlighting behaves on the pages you visit.">
        <label className="mb-4 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-emerald-600"
            checked={showHighlights}
            onChange={(e) => void toggleHighlights(e.target.checked)}
          />
          <span>
            <span className="block font-medium">Show my highlights on saved pages</span>
            <span className="text-neutral-500">
              When you open a page you’ve saved, your Karakeep highlights and notes appear on it. To know which pages
              are saved, the extension asks your Karakeep server about each page you open; turn this off and it only
              contacts the server when you save or highlight.
            </span>
          </span>
        </label>
        <div className="rounded-lg bg-neutral-50 p-4 text-sm leading-relaxed text-neutral-600 dark:bg-neutral-950 dark:text-neutral-400">
          <p className="mb-2">
            The highlight toolbar opens only when you ask for it, never just because you selected text:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Select text, right-click, and choose <b className="font-medium">Highlight with Karakeep</b>
            </li>
            <li>
              Or select text and press <Kbd>{isMac ? '⌥⇧H' : 'Alt+Shift+H'}</Kbd>
            </li>
            <li>
              <Kbd>{isMac ? '⌥⇧S' : 'Alt+Shift+S'}</Kbd> saves the current page
            </li>
          </ul>
          <button
            type="button"
            onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
            className="mt-3 text-xs text-emerald-700 underline underline-offset-2 dark:text-emerald-400"
          >
            Change keyboard shortcuts
          </button>
        </div>
      </Card>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <kbd className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-sans text-xs dark:border-neutral-700 dark:bg-neutral-900">{children}</kbd>
}
