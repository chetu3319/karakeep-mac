import React, { useEffect, useState } from 'react'
import Modal from './Modal'
import Icon, { type IconName } from './Icon'
import { useTheme, type ThemePref } from '../lib/prefs'
import type { User } from '../../../shared/types'

/**
 * Server connection + appearance.
 *
 * Until now the only way to point the app at a different Karakeep server —
 * or to fix a typo in a custom header — was to sign out, which threw away
 * the credentials *and* (before the fix in main/store.ts) the hand-built
 * sidebar ordering. Changing a setting should not require destroying
 * state.
 *
 * The API key field is write-only by design: the stored key lives
 * encrypted in the Keychain and is never sent to the renderer, so there is
 * nothing to prefill it with. Leaving it blank keeps the existing key,
 * which is what makes "change just the server URL" possible.
 */

const THEMES: { value: ThemePref; label: string; icon: IconName }[] = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' }
]

export default function SettingsDialog({
  user,
  onClose,
  onSignOut,
  onReauthenticated
}: {
  user: User
  onClose: () => void
  onSignOut: () => void
  onReauthenticated: (user: User) => void
}): React.JSX.Element {
  const [theme, setTheme] = useTheme()
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [hasStoredKey, setHasStoredKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.kk.config.get().then((cfg) => {
      setBaseUrl(cfg.baseUrl || '')
      setHasStoredKey(cfg.hasApiKey)
      setHeadersText(
        Object.entries(cfg.customHeaders || {})
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')
      )
    })
  }, [])

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const customHeaders: Record<string, string> = {}
      for (const line of headersText.split('\n')) {
        const idx = line.indexOf(':')
        if (idx === -1) continue
        const k = line.slice(0, idx).trim()
        if (k) customHeaders[k] = line.slice(idx + 1).trim()
      }

      // An empty key field means "leave the stored one alone". config.set
      // treats an empty string that way; sending it explicitly keeps that
      // contract in one place rather than branching here.
      await window.kk.config.set({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), customHeaders })

      const result = await window.kk.auth.test()
      if (!result.ok || !result.user) {
        setError(result.error || "Those settings didn't connect. The previous ones are still in effect until this succeeds.")
        return
      }
      setApiKey('')
      setHasStoredKey(true)
      setSaved(true)
      onReauthenticated(result.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="settings-title" className="w-[460px]">
      <form onSubmit={save}>
        <div className="flex items-start justify-between border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
          <div>
            <h2 id="settings-title" className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              Settings
            </h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Signed in as {user.email || user.name || 'this account'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="-mr-1 rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Appearance</h3>
            <div
              role="radiogroup"
              aria-label="Theme"
              className="inline-flex rounded-lg border border-neutral-200 p-0.5 dark:border-neutral-800"
            >
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={theme === t.value}
                  onClick={() => setTheme(t.value)}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs ${
                    theme === t.value
                      ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                      : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
                  }`}
                >
                  <Icon name={t.icon} size={14} />
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Server</h3>
            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">Server URL</span>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:3000"
                spellCheck={false}
                className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-neutral-700"
              />
            </label>
            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">API key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasStoredKey ? 'Stored in your Keychain — leave blank to keep it' : 'Paste your API key'}
                spellCheck={false}
                className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-neutral-700"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs text-neutral-600 dark:text-neutral-400">
                Custom headers <span className="text-neutral-400">(one per line, {'Name: value'})</span>
              </span>
              <textarea
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="CF-Access-Client-Id: …"
                className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-emerald-500 dark:border-neutral-700"
              />
            </label>
          </section>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </p>
          )}
          {saved && !error && (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
              Connected. Settings saved.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-lg px-2.5 py-1.5 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:hover:bg-neutral-800 dark:hover:text-red-400"
          >
            Sign out…
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? 'Checking…' : 'Save & connect'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
