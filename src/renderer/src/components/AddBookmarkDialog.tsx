import React, { useMemo, useState } from 'react'
import { useCreateBookmark, useAddBookmarkToList, useAttachTags, useLists } from '../lib/queries'
import { buildByParent, orderedChildren } from '../lib/listTree'
import type { KKList } from '../../../shared/types'

/** Cheap URL sanity check — enough to catch "not a URL yet" without pretending to fully validate. */
function isLikelyUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function flattenForSelect(lists: KKList[]): { list: KKList; depth: number }[] {
  const byParent = buildByParent(lists)
  const out: { list: KKList; depth: number }[] = []
  function walk(parentKeyValue: string, depth: number): void {
    for (const l of orderedChildren(byParent.get(parentKeyValue) || [], undefined)) {
      out.push({ list: l, depth })
      walk(l.id, depth + 1)
    }
  }
  walk('root', 0)
  return out
}

export default function AddBookmarkDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<'link' | 'text'>('link')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [noteText, setNoteText] = useState('')
  const [targetListId, setTargetListId] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const listsQuery = useLists()
  const listOptions = useMemo(() => flattenForSelect(listsQuery.data || []), [listsQuery.data])

  const createBookmark = useCreateBookmark()
  const addBookmarkToList = useAddBookmarkToList()
  const attachTags = useAttachTags()

  const urlValid = mode === 'link' ? isLikelyUrl(url.trim()) : true
  const textValid = mode === 'text' ? noteText.trim().length > 0 : true
  const canSubmit = urlValid && textValid && !busy

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const tagNames = tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

      const bookmark = await createBookmark.mutateAsync(
        mode === 'link'
          ? { type: 'link', url: url.trim(), title: title.trim() || undefined }
          : { type: 'text', text: noteText.trim(), title: title.trim() || undefined }
      )

      if (targetListId) {
        await addBookmarkToList.mutateAsync({ listId: targetListId, bookmarkId: bookmark.id })
      }
      if (tagNames.length > 0) {
        await attachTags.mutateAsync({ bookmarkId: bookmark.id, tagNames })
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[440px] rounded-2xl border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <h2 className="mb-4 text-lg font-semibold text-neutral-900 dark:text-neutral-100">Add bookmark</h2>

        <div className="mb-4 flex gap-1 rounded-lg bg-neutral-100 p-1 dark:bg-neutral-800">
          <button
            type="button"
            onClick={() => setMode('link')}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium ${
              mode === 'link'
                ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100'
                : 'text-neutral-500 dark:text-neutral-400'
            }`}
          >
            URL
          </button>
          <button
            type="button"
            onClick={() => setMode('text')}
            className={`flex-1 rounded-md py-1.5 text-sm font-medium ${
              mode === 'text'
                ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100'
                : 'text-neutral-500 dark:text-neutral-400'
            }`}
          >
            Note
          </button>
        </div>

        {mode === 'link' ? (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">URL</span>
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onPaste={(e) => {
                // A pasted URL often carries surrounding whitespace/newlines
                // from wherever it was copied — trim immediately so
                // validity feedback matches what actually gets submitted.
                const pasted = e.clipboardData.getData('text')
                if (pasted) setUrl(pasted.trim())
              }}
              placeholder="https://example.com/article"
              className={`w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none dark:border-neutral-700 ${
                url.trim().length === 0
                  ? 'border-neutral-300 focus:border-emerald-500'
                  : urlValid
                    ? 'border-emerald-500'
                    : 'border-red-400'
              }`}
            />
            {url.trim().length > 0 && !urlValid && (
              <span className="mt-1 block text-xs text-red-500">Enter a valid http(s) URL.</span>
            )}
          </label>
        ) : (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Note</span>
            <textarea
              autoFocus
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={4}
              placeholder="Write a note…"
              className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-neutral-700"
            />
          </label>
        )}

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Title (optional)</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={mode === 'link' ? 'Leave blank to use the page title' : 'Untitled note'}
            className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-neutral-700"
          />
        </label>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Add to list (optional)</span>
          <select
            value={targetListId}
            onChange={(e) => setTargetListId(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="">No list</option>
            {listOptions.map(({ list, depth }) => (
              <option key={list.id} value={list.id}>
                {'  '.repeat(depth)}
                {list.icon ? `${list.icon} ` : ''}
                {list.name}
              </option>
            ))}
          </select>
        </label>

        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Tags (optional, comma-separated)</span>
          <input
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="reading, ai, later"
            className="w-full rounded-lg border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-neutral-700"
          />
          <span className="mt-1 block text-xs text-neutral-400">
            A tag that doesn&apos;t exist yet is created automatically.
          </span>
        </label>

        {error && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
