/**
 * Extension settings, kept in chrome.storage.local.
 *
 * A browser extension has no Keychain to put the API key in the way the
 * desktop app does; chrome.storage.local is private to the extension and is
 * never synced, which is the same choice the official Karakeep extension
 * makes. Nothing here goes to chrome.storage.sync for that reason.
 */

export interface Settings {
  baseUrl: string
  apiKey: string
  customHeaders: Record<string, string>
  geminiApiKey: string
  geminiModel: string
  /** Anchor saved highlights whenever a bookmarked page loads. */
  showHighlights: boolean
  /**
   * Base URL for the Gemini REST API. Not exposed in the UI; it exists so the
   * end-to-end harness can point the extension at a local stub.
   */
  geminiEndpoint: string
}

export const DEFAULT_GEMINI_MODEL = 'gemini-3.7-flash'
export const DEFAULT_GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta'

const DEFAULTS: Settings = {
  baseUrl: '',
  apiKey: '',
  customHeaders: {},
  geminiApiKey: '',
  geminiModel: DEFAULT_GEMINI_MODEL,
  showHighlights: true,
  geminiEndpoint: DEFAULT_GEMINI_ENDPOINT
}

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(Object.keys(DEFAULTS) as (keyof Settings)[])) as Partial<Settings>
  return { ...DEFAULTS, ...stored }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch)
}

export function isConfigured(s: Settings): boolean {
  return !!s.baseUrl && !!s.apiKey
}

// Hosts that are almost always reached over plain http on a home network:
// localhost, bare IPv4 addresses, and mDNS names.
const LOCAL_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[^/:]+\.local)(:\d+)?(\/|$)/i

/**
 * Trims a typed server address and fills in a missing scheme: http for a
 * local or LAN address (a self-hosted box at 192.168.1.10:3000), https for
 * anything else. "karakeep.example.com/" -> "https://karakeep.example.com".
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  if (url && !/^https?:\/\//i.test(url)) url = `${LOCAL_HOST.test(url) ? 'http' : 'https'}://${url}`
  return url
}

/** "Header: value" lines -> a header map; lines without a colon are skipped. */
export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const k = line.slice(0, idx).trim()
    if (k) out[k] = line.slice(idx + 1).trim()
  }
  return out
}

export function formatHeaderLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

/** The Karakeep web app's page for one bookmark. */
export function bookmarkWebUrl(baseUrl: string, bookmarkId: string): string {
  return `${baseUrl}/dashboard/preview/${bookmarkId}`
}
