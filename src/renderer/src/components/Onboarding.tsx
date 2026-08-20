import React, { useEffect, useState } from 'react'
import type { User } from '../../../shared/types'

export default function Onboarding({ onSignedIn }: { onSignedIn: (user: User) => void }): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showHeaders, setShowHeaders] = useState(false)
  const [headersText, setHeadersText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prefillNotice, setPrefillNotice] = useState(false)

  useEffect(() => {
    window.kk.config.get().then((cfg) => {
      if (cfg.baseUrl) setBaseUrl(cfg.baseUrl)
      if (cfg.hasApiKey) setPrefillNotice(true)
    })
  }, [])

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      let customHeaders: Record<string, string> | undefined
      if (headersText.trim()) {
        customHeaders = {}
        for (const line of headersText.split('\n')) {
          const idx = line.indexOf(':')
          if (idx === -1) continue
          const k = line.slice(0, idx).trim()
          const v = line.slice(idx + 1).trim()
          if (k) customHeaders[k] = v
        }
      }
      await window.kk.config.set({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), customHeaders })
      const result = await window.kk.auth.test()
      if (!result.ok || !result.user) {
        setError(result.error || 'Sign-in failed')
        return
      }
      onSignedIn(result.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function useSaved(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await window.kk.auth.test()
      if (!result.ok || !result.user) {
        setError(result.error || 'Sign-in failed')
        return
      }
      onSignedIn(result.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full w-full items-center justify-center titlebar-drag">
      <form
        onSubmit={submit}
        className="titlebar-no-drag w-[420px] rounded-2xl border border-neutral-200 bg-white p-8 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <h1 className="mb-1 text-xl font-semibold">Connect to Karakeep</h1>
        <p className="mb-6 text-sm text-neutral-500">Sign in to your self-hosted Karakeep server.</p>

        {prefillNotice && (
          <button
            type="button"
            onClick={useSaved}
            disabled={busy}
            className="mb-4 w-full rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Use saved credentials
          </button>
        )}

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Server URL</span>
          <input
            className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-neutral-700"
            placeholder="http://localhost:3000"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required
          />
        </label>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">API key</span>
          <input
            type="password"
            className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-neutral-700"
            placeholder="kk_..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required
          />
        </label>

        <button
          type="button"
          className="mb-2 text-xs text-neutral-500 underline underline-offset-2"
          onClick={() => setShowHeaders((s) => !s)}
        >
          {showHeaders ? 'Hide' : 'Add'} custom headers
        </button>
        {showHeaders && (
          <textarea
            className="mb-3 w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 font-mono text-xs outline-none dark:border-neutral-700"
            placeholder={'X-Custom-Header: value\nAnother-Header: value'}
            rows={3}
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
          />
        )}

        {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
