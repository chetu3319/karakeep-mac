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
  // Sibling ordering within a list parent (or 'root' for top level) is a
  // client-only concept — Karakeep's /lists response has no order/rank
  // field, so this never round-trips to the server. See shared/types.ts.
  listOrder?: ListOrder
}

export interface ResolvedConfig {
  baseUrl: string
  apiKey: string
  customHeaders: Record<string, string>
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

export function getConfig(): { baseUrl: string; customHeaders: Record<string, string>; hasApiKey: boolean } {
  const disk = readDisk()
  return {
    baseUrl: disk.baseUrl || '',
    customHeaders: disk.customHeaders || {},
    hasApiKey: !!disk.encryptedApiKey
  }
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
  if (safeStorage.isEncryptionAvailable()) {
    disk.encryptedApiKey = safeStorage.encryptString(input.apiKey).toString('base64')
  } else {
    // No Keychain available (unusual on macOS) — do not persist the secret.
    console.warn('[store] safeStorage encryption unavailable; API key will not be persisted')
  }
  writeDisk(disk)
}

export function clearConfig(): void {
  writeDisk({})
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
