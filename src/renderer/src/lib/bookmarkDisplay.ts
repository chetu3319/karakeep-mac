import type { Bookmark } from '../../../shared/types'

/**
 * Karakeep bookmarks come in three content types (`link`, `text`, `asset`)
 * and the API doesn't always fill in a title. This centralizes the
 * fallback logic so the list row and the detail pane agree on what to show
 * instead of both falling through to a bare "Untitled" + no url.
 */
export interface BookmarkDisplay {
  title: string
  subtitle: string
  /** Best URL to open for this bookmark (live page for `link`/`text`, source PDF for `asset`), or '' if none. */
  url: string
  kind: 'link' | 'text' | 'asset' | 'unknown'
}

function decodeFileName(name: string | null | undefined): string {
  if (!name) return ''
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

export function displayForBookmark(b: Bookmark): BookmarkDisplay {
  const content = b.content
  const kind = (content?.type as BookmarkDisplay['kind']) || 'unknown'

  if (kind === 'text') {
    const snippet = (content?.text || '').replace(/\s+/g, ' ').trim()
    const title = b.title || content?.title || (snippet ? snippet.slice(0, 80) : 'Note')
    return {
      title,
      subtitle: content?.sourceUrl || snippet,
      url: content?.sourceUrl || '',
      kind
    }
  }

  if (kind === 'asset') {
    const fileName = decodeFileName(content?.fileName)
    const title = b.title || content?.title || fileName || 'File'
    const assetLabel = content?.assetType ? content.assetType.toUpperCase() : 'FILE'
    return {
      title,
      subtitle: fileName ? `${assetLabel} · ${fileName}` : assetLabel,
      url: content?.sourceUrl || '',
      kind
    }
  }

  if (kind === 'link') {
    const title = b.title || content?.title || content?.url || 'Untitled'
    return { title, subtitle: content?.url || '', url: content?.url || '', kind }
  }

  // Unknown/future content type — still avoid a bare "Untitled" with no context.
  return { title: b.title || content?.title || `Bookmark (${kind})`, subtitle: '', url: content?.url || '', kind }
}
