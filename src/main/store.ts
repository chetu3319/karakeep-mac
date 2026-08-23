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
} {
  const disk = readDisk()
  const hasGeminiKey = !!disk.encryptedGeminiApiKey || !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY
  return {
    baseUrl: disk.baseUrl || '',
    customHeaders: disk.customHeaders || {},
    hasApiKey: !!disk.encryptedApiKey,
    hasGeminiApiKey: hasGeminiKey,
    geminiModel: disk.geminiModel || 'gemini-2.5-flash'
  }
}

export function getResolvedAiConfig(): ResolvedAiConfig | null {
  const disk = readDisk()
  const model = disk.geminiModel || 'gemini-2.5-flash'
  let apiKey = ''

  if (disk.encryptedGeminiApiKey && safeStorage.isEncryptionAvailable()) {
    try {
      apiKey = safeStorage.decryptString(Buffer.from(disk.encryptedGeminiApiKey, 'base64'))
    } catch {
      // ignore decryption failure and fallback
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
    } else if (safeStorage.isEncryptionAvailable()) {
      disk.encryptedGeminiApiKey = safeStorage.encryptString(input.geminiApiKey).toString('base64')
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
