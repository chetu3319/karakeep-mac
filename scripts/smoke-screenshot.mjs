#!/usr/bin/env node
/**
 * Dev-only smoke test: builds the app, launches it with KK_SMOKE=1 (which
 * makes main/index.ts drive itself through library -> detail -> web-pane
 * and capture a screenshot at each step into ./tmp-screenshots/), then
 * exits. Credentials are passed as env vars to the child process only —
 * never printed, never written to a file.
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const screenshotDir = join(root, 'tmp-screenshots')
mkdirSync(screenshotDir, { recursive: true })

function loadEnvLocal() {
  const p = join(root, '.env.local')
  const out = {}
  if (!existsSync(p)) return out
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return out
}

console.log('[smoke] building...')
const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('[smoke] build failed')
  process.exit(1)
}

const electronBin = join(root, 'node_modules', '.bin', 'electron')
const envVars = loadEnvLocal()

console.log('[smoke] launching electron with KK_SMOKE=1...')
const child = spawn(electronBin, [join(root, 'out', 'main', 'index.js')], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...envVars,
    KK_SMOKE: '1'
  }
})

child.on('exit', (code) => {
  console.log('[smoke] electron exited with code', code)
  const expected = ['01-library.png', '02-detail.png', '03-web.png']
  const found = expected.filter((f) => existsSync(join(screenshotDir, f)))
  console.log('[smoke] screenshots found:', found)
  if (found.length !== expected.length) {
    console.error('[smoke] MISSING screenshots:', expected.filter((f) => !found.includes(f)))
    process.exit(1)
  }
  process.exit(0)
})
