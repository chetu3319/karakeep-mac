#!/usr/bin/env node
/**
 * Build the macOS app icon from the Karakeep mark.
 *
 * The upstream mark is drawn for the web: it bleeds to the edge of its
 * canvas, and the page and bookmark inside it are *transparent* knockouts
 * rather than white shapes. Both are right for a favicon composited onto a
 * page, and wrong for a Dock icon — full-bleed art sits visibly larger
 * than every native icon beside it, and transparent knockouts would let
 * the user's wallpaper show through the middle of the bookmark, which
 * reads as a rendering bug rather than a design.
 *
 * So this rebuilds it from the vector source at icon proportions:
 *
 *   - the artwork is inset to 824px within a 1024px canvas, the
 *     proportion Apple's icon grid uses, so it sits at the same visual
 *     size as its neighbours;
 *   - the knockouts are painted white, matching how the mark actually
 *     *appears* everywhere it is used, rather than how it is stored.
 *
 * The mark's own corner radius is left alone. It is tighter than the
 * macOS squircle, so this reads as the Karakeep icon rather than as a
 * platform-native tile — which is the point of using it.
 *
 * Rendering goes through Electron (already a dependency, and the only
 * renderer here that handles SVG with real transparency), then sips and
 * iconutil, both part of macOS. No new dependencies.
 *
 * Usage: node scripts/make-icon.mjs
 * Output: build-resources/icon.icns, build-resources/icon.png
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'build-resources')
const work = join(root, 'build-resources', '.iconwork')

/**
 * The Karakeep mark, as three subpaths in its own 598x166 lockup
 * coordinate space: the rounded square, then the page and the bookmark
 * that are knocked out of it.
 *
 * Copied from the logo Karakeep serves at /icons/karakeep-full.svg (the
 * first path of that file — the rest is the wordmark). Kept as data here
 * so the build does not depend on reaching a running server.
 */
const MARK = {
  tile:
    'M116.76,26.63L32.75,26.63C29.64,26.63 27.12,29.15 27.12,32.26L27.12,115.84C27.12,118.95 29.64,121.47 32.75,121.47L116.76,121.47C119.87,121.47 122.39,118.95 122.39,115.84L122.39,32.26C122.39,29.15 119.87,26.63 116.76,26.63Z',
  page:
    'M68.75,107.54C68.75,108.35 68.09,109.01 67.28,109.01L41.38,109.01C40.57,109.01 39.91,108.35 39.91,107.54L39.91,40.25C39.91,39.44 40.57,38.78 41.38,38.78L66.87,38.78C67.68,38.78 68.34,39.44 68.34,40.25L68.34,65.86C68.34,65.86 68.2,76.88 68.75,85.53L68.75,107.54Z',
  bookmark:
    'M109.19,107.54C109.19,108.71 107.89,109.41 106.91,108.77L95.1,101.05C94.59,100.72 93.93,100.73 93.43,101.09L83.08,108.58C82.65,108.89 82.14,108.92 81.71,108.75C81.33,108.48 81.08,108.05 81.08,107.55L81.08,55.29C82.48,55.01 84.04,54.87 85.84,54.87C94.69,54.87 109.19,59.86 109.19,73.96L109.19,107.54Z'
}

// Bounding box of the tile subpath in that source space.
const SRC = { x: 27.12, y: 26.63, w: 95.27, h: 94.84 }

const CANVAS = 1024
/** Apple's icon grid: the rounded-rect body fills 824 of a 1024 canvas. */
const BODY = 824

function buildSvg() {
  const scale = BODY / SRC.w
  const tx = (CANVAS - SRC.w * scale) / 2 - SRC.x * scale
  const ty = (CANVAS - SRC.h * scale) / 2 - SRC.y * scale
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <g transform="translate(${tx.toFixed(3)},${ty.toFixed(3)}) scale(${scale.toFixed(6)})">
    <path d="${MARK.tile}" fill="#000000"/>
    <path d="${MARK.page}" fill="#ffffff"/>
    <path d="${MARK.bookmark}" fill="#ffffff"/>
  </g>
</svg>`
}

/**
 * Render the SVG to a transparent PNG through Electron.
 *
 * Two things here are not obvious and both cost an afternoon:
 *
 * `loadFile`, not `loadURL('data:text/html,…')` — Chromium blocks
 * top-level navigation to data: URLs, and in Electron 32 the load simply
 * never settles, so the script hangs rather than failing.
 *
 * The window is sized in *CSS* pixels, so on a Retina display a 512px
 * window captures as a 1024px image. Dividing the target by the display's
 * scale factor means the capture comes out at the size we asked for
 * whatever machine this runs on, and gets supersampled for free where the
 * display is 2x.
 */
function renderPng(svg, target) {
  const runner = join(work, 'render.cjs')
  const page = join(work, 'icon.html')
  writeFileSync(
    runner,
    `const { app, BrowserWindow, screen } = require('electron')
const { writeFileSync } = require('node:fs')

// A hung render must not wedge a build.
setTimeout(() => {
  console.error('[icon] render timed out')
  app.exit(1)
}, 30000)

app.whenReady().then(async () => {
  const scale = screen.getPrimaryDisplay().scaleFactor || 1
  const css = Math.round(${CANVAS} / scale)
  const win = new BrowserWindow({
    width: css,
    height: css,
    // Off the side of the display so the render does not flash a black
    // square over whatever the user is doing. It still composites, which
    // is what capturePage needs.
    x: -4000,
    y: -4000,
    frame: false,
    transparent: true,
    // Without this the capture is composited onto opaque white and the
    // icon ships with white square corners instead of transparent ones.
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false }
  })
  win.setIgnoreMouseEvents(true)
  await win.loadFile(${JSON.stringify(page)})
  await new Promise((r) => setTimeout(r, 700))
  const image = await win.webContents.capturePage()
  writeFileSync(${JSON.stringify(target)}, image.toPNG())
  app.exit(0)
})
`,
    'utf-8'
  )

  // The SVG carries a 1024 viewBox but is sized to the window in CSS
  // pixels, so the scale factor above decides the real output resolution.
  writeFileSync(
    page,
    `<html><head><style>
       html,body{margin:0;padding:0;background:transparent;overflow:hidden}
       svg{display:block;width:100vw;height:100vh}
     </style></head><body>${svg}</body></html>`,
    'utf-8'
  )

  const electron = join(root, 'node_modules', '.bin', 'electron')
  const res = spawnSync(electron, [runner], { stdio: 'inherit' })
  if (res.status !== 0) throw new Error('electron render failed')
}

function sh(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`${cmd} failed`)
}

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
mkdirSync(outDir, { recursive: true })

const master = join(work, `icon-${CANVAS}.png`)
console.log(`[icon] rendering ${CANVAS}x${CANVAS}…`)
renderPng(buildSvg(), master)
// Normalise: a display whose scale factor does not divide the canvas
// evenly would otherwise leave the master a pixel or two off.
sh('sips', ['-z', String(CANVAS), String(CANVAS), master, '--out', master])

// iconutil wants every size the Finder and Dock might ask for, at 1x and
// 2x. Downscaling from the single 1024 master keeps them all identical
// artwork rather than nine separate renders that could drift.
const iconset = join(work, 'icon.iconset')
mkdirSync(iconset, { recursive: true })
const sizes = [16, 32, 128, 256, 512]
for (const size of sizes) {
  for (const scale of [1, 2]) {
    const px = size * scale
    const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`
    sh('sips', ['-z', String(px), String(px), master, '--out', join(iconset, name)])
  }
}

console.log('[icon] packing icns…')
sh('iconutil', ['-c', 'icns', iconset, '-o', join(outDir, 'icon.icns')])
sh('sips', ['-z', '512', '512', master, '--out', join(outDir, 'icon.png')])

rmSync(work, { recursive: true, force: true })
console.log('[icon] wrote build-resources/icon.icns and build-resources/icon.png')
