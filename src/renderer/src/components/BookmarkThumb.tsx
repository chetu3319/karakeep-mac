import React, { useState } from 'react'
import type { Bookmark } from '../../../shared/types'
import type { BookmarkDisplay } from '../lib/bookmarkDisplay'
import AssetImage from './AssetImage'

function faviconFallback(url?: string | null): string {
  try {
    if (!url) return ''
    const u = new URL(url)
    return `${u.protocol}//${u.host}/favicon.ico`
  } catch {
    return ''
  }
}

/** Generic glyph fallback — never lets a broken <img> render its native broken-icon. */
function Glyph({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center text-neutral-400 dark:text-neutral-500">
      <span className="text-base">{label}</span>
    </div>
  )
}

function RemoteImage({ src, alt }: { src: string; alt: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <Glyph label="🌐" />
  return (
    <img src={src} alt={alt} className="h-full w-full object-contain p-1.5" onError={() => setFailed(true)} />
  )
}

export default function BookmarkThumb({
  bookmark,
  display
}: {
  bookmark: Bookmark
  display: BookmarkDisplay
}): React.JSX.Element {
  const content = bookmark.content

  if (display.kind === 'text') return <Glyph label="📝" />
  if (display.kind === 'asset') {
    const assetType = content?.assetType
    return <Glyph label={assetType === 'pdf' ? '📄' : '📎'} />
  }

  // link (or unknown, best-effort as a link)
  if (content?.imageAssetId) {
    return <AssetImage assetId={content.imageAssetId} className="h-full w-full object-cover" alt={display.title} />
  }
  if (content?.favicon) {
    return <RemoteImage src={content.favicon} alt="" />
  }
  return <RemoteImage src={faviconFallback(display.url)} alt="" />
}
