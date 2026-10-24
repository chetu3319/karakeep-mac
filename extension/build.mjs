// Builds the Chrome extension into extension/dist (load it unpacked from
// there). `node extension/build.mjs --watch` rebuilds on change.
import { build, context } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

const root = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')
// --e2e builds into dist-e2e with the popover's shadow root left open, so the
// end-to-end run can click inside it. Never ship that build: a closed root is
// what keeps the page's own scripts out of the toolbar.
const e2e = process.argv.includes('--e2e')
const out = join(root, e2e ? 'dist-e2e' : 'dist')

const common = {
  bundle: true,
  target: 'chrome120',
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  // The shared modules come from the desktop app's tree; none of them may
  // pull in Electron, and this makes any that try fail loudly.
  external: ['electron'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
    __KK_SHADOW_MODE__: JSON.stringify(e2e ? 'open' : 'closed')
  }
}

const entries = [
  // A module service worker, so it can be ESM; everything else runs as a
  // classic script (content scripts cannot be modules).
  { entryPoints: { background: join(root, 'src/background.ts') }, format: 'esm' },
  { entryPoints: { content: join(root, 'src/content.ts') }, format: 'iife' },
  { entryPoints: { popup: join(root, 'src/popup/main.tsx'), options: join(root, 'src/options/main.tsx') }, format: 'iife' }
]

async function buildCss() {
  const input = await readFile(join(root, 'src/styles.css'), 'utf8')
  const result = await postcss([tailwindcss({ config: join(root, 'tailwind.config.cjs') }), autoprefixer]).process(input, {
    from: join(root, 'src/styles.css')
  })
  await writeFile(join(out, 'styles.css'), result.css)
}

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await cp(join(root, 'public'), out, { recursive: true })
await buildCss()

if (watch) {
  for (const e of entries) {
    const ctx = await context({ ...common, ...e, outdir: out })
    await ctx.watch()
  }
  console.log('watching… (CSS and public/ are rebuilt only on restart)')
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e, outdir: out })))
}
