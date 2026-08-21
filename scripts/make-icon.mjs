#!/usr/bin/env node
/**
 * Build the macOS app icon.
 *
 * The artwork is generated rather than checked in as an opaque binary, so
 * the geometry below is inspectable and the icon can be rebuilt at any
 * size. Rendering goes through Electron (already a dependency, and the
 * only renderer here that handles SVG with real transparency), then sips
 * and iconutil, both part of macOS. No new dependencies.
 *
 * The design is deliberately generic: a bookmark ribbon on an emerald
 * tile. The ribbon is the category's universal symbol rather than anyone's
 * trademark, and emerald is this app's own accent — the same colour as the
 * New bookmark button and every selected row.
 *
 * Usage: npm run icon
 * Output: build-resources/icon.icns, build-resources/icon.png
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'build-resources')
const work = join(root, 'build-resources', '.iconwork')

const CANVAS = 1024
/** Apple's icon grid: the tile fills 824 of a 1024 canvas. */
const BODY = 824

/**
 * Tailwind emerald-400 -> emerald-700. A wide range on purpose: a tighter
 * one (500 -> 700) renders as a flat sage green at Dock size, where the
 * gradient is only ~60px tall and needs the contrast to read as depth
 * rather than as a slightly dirty fill.
 */
const TILE_TOP = '#34d399'
const TILE_BOTTOM = '#047857'

/**
 * macOS app tiles are not rounded rectangles. They are superellipses —
 * the curvature eases into the straight edge instead of meeting it at a
 * tangent, which is why a plain `rx` rounded rect looks subtly wrong
 * sitting in the Dock next to real ones.
 *
 * |x/a|^n + |y/a|^n = 1 is a close match and, unlike the Bézier
 * constructions, is exact at any size. The exponent is not a guess: it is
 * the least-squares fit to the alpha profile of /System/Applications/
 * Notes.app's own icon, measured at 2/5/10/20% down from the top edge.
 * Sampled densely enough that the polygon is indistinguishable from a
 * curve at 1024px.
 */
const SQUIRCLE_N = 5.1

function squirclePath(cx, cy, half, n = SQUIRCLE_N, steps = 720) {
  const pts = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI
    const ct = Math.cos(t)
    const st = Math.sin(t)
    // Signed |cos|^(2/n) form — the standard superellipse parameterisation.
    const x = Math.sign(ct) * Math.abs(ct) ** (2 / n) * half
    const y = Math.sign(st) * Math.abs(st) ** (2 / n) * half
    pts.push(`${(cx + x).toFixed(2)},${(cy + y).toFixed(2)}`)
  }
  return `M${pts.join('L')}Z`
}

/**
 * The bookmark: rounded top corners, square shoulders, a V cut out of the
 * bottom. Kept wide and short rather than the thin ribbon a UI icon would
 * use — at 16px in the Finder sidebar a thin one closes up into a smudge.
 */
function bookmarkPath({ x, y, w, h, notch, r }) {
  const x1 = x + w
  const y1 = y + h
  const cx = x + w / 2
  return [
    `M${x + r},${y}`,
    `L${x1 - r},${y}`,
    `Q${x1},${y} ${x1},${y + r}`,
    `L${x1},${y1}`,
    `L${cx},${y1 - notch}`,
    `L${x},${y1}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    'Z'
  ].join(' ')
}

function buildSvg() {
  const half = BODY / 2
  const centre = CANVAS / 2

  const w = 264
  const h = 444
  const bookmark = bookmarkPath({
    x: centre - w / 2,
    // Optically centred rather than measured-centred: the V removes mass
    // from the bottom, so a mathematically centred ribbon reads as
    // sitting slightly high.
    y: centre - h / 2 - 18,
    w,
    h,
    notch: 92,
    r: 22
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${TILE_TOP}"/>
      <stop offset="1" stop-color="${TILE_BOTTOM}"/>
    </linearGradient>
  </defs>
  <path d="${squirclePath(centre, centre, half)}" fill="url(#tile)"/>
  <path d="${bookmark}" fill="#ffffff"/>
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
    // Off the side of the display so the render does not flash a coloured
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
for (const size of [16, 32, 128, 256, 512]) {
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
