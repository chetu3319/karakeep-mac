/**
 * Pure helpers for region capture: the rectangle a user drags over a figure or
 * equation, how it maps onto a PDF page, how big the captured image may be, and
 * what the resulting chip is called. Shared by the renderer (PDF), the web
 * page's preload and main so they all agree on the numbers.
 */

/** A drag shorter than this (either side, CSS px) is a click, not a capture. */
export const MIN_CAPTURE_PX = 8
/** Longest side of a captured image sent to the model. */
export const MAX_CAPTURE_SIDE = 1600
/** Longest region text kept alongside the image. */
export const MAX_REGION_TEXT = 2000

export interface PxRect {
  x: number
  y: number
  width: number
  height: number
}

/** The rectangle between two pointer positions, whichever way the drag went. */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number): PxRect {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) }
}

/** True when a drag is too small to count as a deliberate region. */
export function isTinyDrag(r: { width: number; height: number }): boolean {
  return !(r.width >= MIN_CAPTURE_PX && r.height >= MIN_CAPTURE_PX)
}

export function rectsIntersect(a: PxRect, b: PxRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

export function intersection(a: PxRect, b: PxRect): PxRect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

/** A rendered PDF page: its box on screen and its size in page units. */
export interface PageBox {
  /** 0-based page index. */
  page: number
  box: PxRect
  /** Page width in PDF units, to recover the on-screen scale. */
  pageWidth: number
}

/** The page the drag covers most, or null when it touches none. */
export function pickPage(drag: PxRect, pages: PageBox[]): PageBox | null {
  let best: PageBox | null = null
  let bestArea = 0
  for (const p of pages) {
    const hit = intersection(drag, p.box)
    const area = hit ? hit.width * hit.height : 0
    if (area > bestArea) {
      best = p
      bestArea = area
    }
  }
  return best
}

/**
 * Screen drag (client px) to page coordinates: clipped to the page, shifted by
 * the page's own offset and divided by the on-screen scale.
 */
export function screenToPageRect(drag: PxRect, p: PageBox): (PxRect & { scale: number }) | null {
  const hit = intersection(drag, p.box)
  if (!hit || !p.pageWidth || !p.box.width) return null
  const scale = p.box.width / p.pageWidth
  return {
    x: (hit.x - p.box.x) / scale,
    y: (hit.y - p.box.y) / scale,
    width: hit.width / scale,
    height: hit.height / scale,
    scale
  }
}

/**
 * The scale to render a page rectangle at: sharp for the display
 * (`uiScale * dpr`) but never so big its long side passes `max`.
 */
export function renderScaleFor(width: number, height: number, uiScale: number, dpr: number, max = MAX_CAPTURE_SIDE): number {
  const wanted = Math.max(0.01, uiScale * Math.max(1, dpr))
  const long = Math.max(width, height)
  if (!(long > 0)) return wanted
  return Math.min(wanted, max / long)
}

/** Size an image of `width` x `height` pixels is brought down to; unchanged when it already fits. */
export function fitLongSide(width: number, height: number, max = MAX_CAPTURE_SIDE): { width: number; height: number } {
  const long = Math.max(width, height)
  if (long <= max || !(long > 0)) return { width, height }
  const k = max / long
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

/** `Figure · p.N` when the text under the region starts with "Fig", else `Region · p.N`. */
export function regionLabel(text: string, page?: number): string {
  const head = /^\s*fig/i.test(text) ? 'Figure' : 'Region'
  return page ? `${head} · p.${page}` : head
}

/** Collapses whitespace and bounds the text kept with a region. */
export function tidyRegionText(text: string, max = MAX_REGION_TEXT): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) : t
}

export interface GlyphBox {
  x: number
  y: number
  width: number
  height: number
}

export interface RunLike {
  charStart: number
  glyphs: GlyphBox[]
}

/**
 * Contiguous glyph index ranges (inclusive) whose boxes intersect `rect`, in
 * reading (index) order.
 */
export function glyphSpansInRect(runs: RunLike[], rect: PxRect): Array<{ from: number; to: number }> {
  const hits: number[] = []
  for (const run of runs) {
    run.glyphs.forEach((g, i) => {
      if (g.width <= 0 && g.height <= 0) return
      if (rectsIntersect(rect, g)) hits.push(run.charStart + i)
    })
  }
  hits.sort((a, b) => a - b)
  const spans: Array<{ from: number; to: number }> = []
  for (const h of hits) {
    const last = spans[spans.length - 1]
    if (last && h === last.to + 1) last.to = h
    else spans.push({ from: h, to: h })
  }
  return spans
}

/** The part of window.visualViewport the conversion needs (CSS px, layout-viewport space). */
export interface VisualViewportLike {
  offsetLeft: number
  offsetTop: number
  width: number
  height: number
  scale: number
}

/**
 * A rectangle in layout-viewport CSS px (pointer clientX/Y, position: fixed)
 * to the visible-area space `capturePage` works in. Under pinch zoom the
 * visible area is the visual viewport, magnified by `scale` and offset inside
 * the layout viewport. The rectangle is clipped to what is visible first, and
 * null when none of it is.
 */
export function layoutToVisualRect(r: PxRect, vv: VisualViewportLike): PxRect | null {
  const scale = vv.scale > 0 ? vv.scale : 1
  const hit = intersection(r, { x: vv.offsetLeft, y: vv.offsetTop, width: vv.width, height: vv.height })
  if (!hit) return null
  return {
    x: (hit.x - vv.offsetLeft) * scale,
    y: (hit.y - vv.offsetTop) * scale,
    width: hit.width * scale,
    height: hit.height * scale
  }
}

/** A PNG data URL longer than this is re-encoded smaller (about 4MB of text). */
export const MAX_ENCODED_CHARS = 4_000_000

export function encodedTooLarge(dataUrl: string): boolean {
  return dataUrl.length > MAX_ENCODED_CHARS
}

/** What a web capture hands back: the picture, a reason it could not start, or null for a cancel. */
export type RegionCaptureResult = { imageDataUrl: string; text: string } | { error: string } | null
