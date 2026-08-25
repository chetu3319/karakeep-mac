/**
 * Persisted app config. The API key is encrypted at rest with Electron's
 * safeStorage (backed by macOS Keychain) and stored base64-encoded in a
 * plain JSON file alongside non-secret settings. The key is never written
 * to disk in plaintext and never logged.
 */
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ListOrder } from '../shared/types'

interface OnDiskConfig {
  baseUrl?: string
  customHeaders?: Record<string, string>
  encryptedApiKey?: string // base64
  encryptedGeminiApiKey?: string // base64
  // Set instead of encryptedGeminiApiKey only when safeStorage was
  // unavailable at save time (see setAiConfig). Keeping the two fields
  // separate means a decrypt *failure* on encryptedGeminiApiKey can never
  // be confused with "this was deliberately stored unencrypted" — the old
  // code conflated them by catching decryptString() and falling back to
  // treating the (still-encrypted, undecryptable) blob as if it were the
  // plaintext key, which handed Google a base64 blob instead of a real key.
  plaintextGeminiApiKey?: string
  geminiModel?: string
  // Sibling ordering within a list parent (or 'root' for top level) is a
  // client-only concept — Karakeep's /lists response has no order/rank
  // field, so this never round-trips to the server. See shared/types.ts.
  listOrder?: ListOrder
  windowState?: WindowState
}

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

export interface ResolvedConfig {
  baseUrl: string
  apiKey: string
  customHeaders: Record<string, string>
}

export interface ResolvedAiConfig {
  geminiApiKey: string
  geminiModel: string
}

// The only two models the rest of the app knows how to prompt correctly
// (see main/ai.ts's thinkingLevel/maxOutputTokens tables, which are keyed
// off mode, not model, but were tuned against these two). Anything else —
// most importantly a config written before this migration, holding
// `gemini-2.5-flash`, `gemini-1.5-flash` or `gemini-1.5-pro` — 404s against
// the live API on every single request, so it is treated as unset rather
// than sent through.
const SUPPORTED_GEMINI_MODELS = ['gemini-3.7-flash', 'gemini-3.1-pro-preview'] as const
const DEFAULT_GEMINI_MODEL = 'gemini-3.7-flash'

function resolveGeminiModel(stored: string | undefined): string {
  if (stored && (SUPPORTED_GEMINI_MODELS as readonly string[]).includes(stored)) return stored
  return DEFAULT_GEMINI_MODEL
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function readDisk(): OnDiskConfig {
  const p = configPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as OnDiskConfig
  } catch {
    return {}
  }
}

function writeDisk(cfg: OnDiskConfig): void {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf-8')
}

export function getConfig(): {
  baseUrl: string
  customHeaders: Record<string, string>
  hasApiKey: boolean
  hasGeminiApiKey: boolean
  geminiModel: string
  // True only when a Gemini key is on disk in `plaintextGeminiApiKey` — i.e.
  // safeStorage was unavailable when it was saved. Settings uses this to
  // show a warning; it is never true just because decryption is possible.
  geminiKeyUnencrypted: boolean
} {
  const disk = readDisk()
  const hasGeminiKey =
    !!disk.encryptedGeminiApiKey ||
    !!disk.plaintextGeminiApiKey ||
    !!process.env.GEMINI_API_KEY ||
    !!process.env.GOOGLE_API_KEY
  return {
    baseUrl: disk.baseUrl || '',
    customHeaders: disk.customHeaders || {},
    hasApiKey: !!disk.encryptedApiKey,
    hasGeminiApiKey: hasGeminiKey,
    geminiModel: resolveGeminiModel(disk.geminiModel),
    geminiKeyUnencrypted: !!disk.plaintextGeminiApiKey
  }
}

export function getResolvedAiConfig(): ResolvedAiConfig | null {
  const disk = readDisk()
  const model = resolveGeminiModel(disk.geminiModel)
  let apiKey = ''

  // `plaintextGeminiApiKey` and `encryptedGeminiApiKey` are mutually
  // exclusive by construction (see setAiConfig) — which one is set records
  // how the key was actually stored, so there is no ambiguity to resolve
  // here the way the old single-field version had to guess at.
  if (disk.plaintextGeminiApiKey) {
    apiKey = disk.plaintextGeminiApiKey
  } else if (disk.encryptedGeminiApiKey && safeStorage.isEncryptionAvailable()) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(disk.encryptedGeminiApiKey, 'base64'))
    } catch {
      // A genuine decrypt failure (corrupted blob, Keychain entry deleted
      // out from under us, key material from a different machine). The old
      // code fell back to using the raw encrypted/base64 bytes *as* the API
      // key here, which just sends Google garbage instead of failing
      // cleanly — treat this the same as "no key configured".
      apiKey = ''
    }
  }

  if (!apiKey) {
    apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ''
  }

  if (!apiKey) return null
  return { geminiApiKey: apiKey, geminiModel: model }
}

export function setAiConfig(input: { geminiApiKey?: string; geminiModel?: string }): void {
  const disk = readDisk()
  if (input.geminiModel) {
    disk.geminiModel = input.geminiModel
  }
  if (input.geminiApiKey !== undefined) {
    if (!input.geminiApiKey) {
      delete disk.encryptedGeminiApiKey
      delete disk.plaintextGeminiApiKey
    } else if (safeStorage.isEncryptionAvailable()) {
      disk.encryptedGeminiApiKey = safeStorage.encryptString(input.geminiApiKey).toString('base64')
      delete disk.plaintextGeminiApiKey
    } else {
      // No Keychain available — this mirrors the deliberate fallback in
      // setConfig()'s sibling for the Karakeep API key (commit c905f0d):
      // storing the key unencrypted beats not storing it at all, since the
      // whole AI feature is otherwise unusable on this machine. The
      // distinct field name is what lets getResolvedAiConfig() and
      // getConfig() tell "stored in the clear on purpose" apart from "the
      // encrypted blob failed to decrypt" — see the comments there.
      disk.plaintextGeminiApiKey = input.geminiApiKey
      delete disk.encryptedGeminiApiKey
      console.warn('[store] safeStorage encryption unavailable; Gemini API key will be stored unencrypted')
    }
  }
  writeDisk(disk)
}

export function getResolvedConfig(): ResolvedConfig | null {
  const disk = readDisk()
  if (!disk.baseUrl || !disk.encryptedApiKey) return null
  if (!safeStorage.isEncryptionAvailable()) {
    // Fall back: treat as unusable rather than storing plaintext.
    return null
  }
  let apiKey: string
  try {
    apiKey = safeStorage.decryptString(Buffer.from(disk.encryptedApiKey, 'base64'))
  } catch {
    return null
  }
  return { baseUrl: disk.baseUrl, apiKey, customHeaders: disk.customHeaders || {} }
}

export function setConfig(input: {
  baseUrl: string
  apiKey: string
  customHeaders?: Record<string, string>
}): void {
  const disk = readDisk()
  disk.baseUrl = input.baseUrl
  disk.customHeaders = input.customHeaders || {}
  // An empty key means "leave the stored one alone". The renderer can
  // never read the stored key back (it lives encrypted, and is resolved
  // only in main), so the Settings dialog has nothing to prefill its
  // field with — without this, saving a changed *server URL* would
  // silently overwrite a perfectly good API key with the empty string.
  if (!input.apiKey) {
    writeDisk(disk)
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    disk.encryptedApiKey = safeStorage.encryptString(input.apiKey).toString('base64')
  } else {
    // No Keychain available (unusual on macOS) — do not persist the secret.
    console.warn('[store] safeStorage encryption unavailable; API key will not be persisted')
  }
  writeDisk(disk)
}

/**
 * Sign out: forget the credentials, keep everything that isn't one.
 *
 * This used to be `writeDisk({})`, which also took `listOrder` and
 * `windowState` with it. `listOrder` is the hand-arranged sidebar tree —
 * it is real, unrecoverable user work that Karakeep's API does not store
 * (there is no order field on /lists), and it was being destroyed by a
 * single unconfirmed click on a button in the window chrome. Signing out
 * is about credentials; it has no business touching the furniture.
 */
export function clearConfig(): void {
  const disk = readDisk()
  writeDisk({ listOrder: disk.listOrder, windowState: disk.windowState })
}

export function getWindowState(): WindowState | null {
  return readDisk().windowState ?? null
}

export function setWindowState(state: WindowState): void {
  const disk = readDisk()
  disk.windowState = state
  writeDisk(disk)
}

export function getListOrder(): ListOrder {
  const disk = readDisk()
  return disk.listOrder || {}
}

export function setListOrder(order: ListOrder): void {
  const disk = readDisk()
  disk.listOrder = order
  writeDisk(disk)
}

/** Dev convenience: seed config from .env.local if no config exists yet. */
export function seedFromEnvIfEmpty(env: {
  KARAKEEP_BASE_URL?: string
  KARAKEEP_API_KEY?: string
}): void {
  const disk = readDisk()
  if (disk.baseUrl && disk.encryptedApiKey) return
  if (!env.KARAKEEP_BASE_URL || !env.KARAKEEP_API_KEY) return
  setConfig({ baseUrl: env.KARAKEEP_BASE_URL, apiKey: env.KARAKEEP_API_KEY })
}
