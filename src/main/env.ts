/** Minimal .env.local loader — no external dependency needed for two vars. */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export function loadDotEnvLocal(root: string): Record<string, string> {
  const p = join(root, '.env.local')
  const result: Record<string, string> = {}
  if (!existsSync(p)) return result
  const content = readFileSync(p, 'utf-8')
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}
