import React, { useMemo, useState } from 'react'
import { useAttachTags, useDetachTags, useTags } from '../lib/queries'
import type { Bookmark } from '../../../shared/types'
import { errMessage } from '../lib/errors'

/**
 * The tags on one bookmark, with a chip each and an add box.
 *
 * Karakeep addresses tags by *name* on the bookmark-tag endpoints (there is
 * no standalone create-tag call — POST /bookmarks/{id}/tags brings a tag
 * into existence if it doesn't already exist), so both directions here work
 * from names rather than ids.
 */
export default function TagEditor({ bookmark }: { bookmark: Bookmark }): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const attachTags = useAttachTags()
  const detachTags = useDetachTags()
  const allTags = useTags()

  const attached = bookmark.tags || []
  const attachedNames = useMemo(
    () => new Set(attached.map((t) => t.name.toLowerCase())),
    [attached]
  )

  // Datalist of existing tags minus the ones already on this bookmark, so
  // the suggestions only ever offer something that would actually change
  // anything.
  const suggestions = useMemo(
    () => (allTags.data || []).filter((t) => !attachedNames.has(t.name.toLowerCase())),
    [allTags.data, attachedNames]
  )

  function commitAdd(): void {
    const names = draft
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      // Re-attaching a tag the bookmark already has is a no-op server-side,
      // but it still costs a round trip and a full bookmark refetch.
      .filter((name) => !attachedNames.has(name.toLowerCase()))
    setDraft('')
    setAdding(false)
    if (names.length === 0) return
    setError(null)
    attachTags.mutate(
      { bookmarkId: bookmark.id, tagNames: names },
      { onError: (err) => setError(`Couldn't add the tag. ${errMessage(err)}`) }
    )
  }

  function removeTag(name: string): void {
    setError(null)
    detachTags.mutate(
      { bookmarkId: bookmark.id, tagNames: [name] },
      { onError: (err) => setError(`Couldn't remove the tag. ${errMessage(err)}`) }
    )
  }

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {attached.map((t) => (
          <span
            key={t.id}
            className="group flex items-center gap-1 rounded-full bg-neutral-100 py-0.5 pl-2 pr-1 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          >
            #{t.name}
            <button
              type="button"
              onClick={() => removeTag(t.name)}
              title={`Remove #${t.name} from this bookmark`}
              aria-label={`Remove tag ${t.name}`}
              className="rounded-full px-1 text-neutral-400 hover:bg-neutral-200 hover:text-red-600 dark:hover:bg-neutral-700 dark:hover:text-red-400"
            >
              ×
            </button>
          </span>
        ))}

        {adding ? (
          <span className="inline-flex items-center">
            <input
              autoFocus
              value={draft}
              list="kk-tag-suggestions"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitAdd}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitAdd()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setDraft('')
                  setAdding(false)
                }
              }}
              placeholder="tag name"
              className="w-36 rounded-full border border-emerald-500 bg-transparent px-2 py-0.5 text-xs outline-none"
            />
            <datalist id="kk-tag-suggestions">
              {suggestions.map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-full border border-dashed border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-neutral-700 dark:hover:border-emerald-500 dark:hover:text-emerald-400"
          >
            + Tag
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}

