import React, { useMemo, useRef, useState } from 'react'
import { useCreateBookmark, useAddBookmarkToList, useAttachTags, useLists } from '../lib/queries'
import { useCreateFileBookmarks } from '../lib/fileBookmarks'
import { buildByParent, orderedChildren } from '../lib/listTree'
import type { KKList } from '../../../shared/types'

// What the file picker offers. Karakeep stores images and PDFs as assets;
// anything else is refused by POST /assets with "Unsupported asset type".
const FILE_ACCEPT = 'application/pdf,image/*'

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

type Mode = 'link' | 'text' | 'file'

export default function AddBookmarkDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('link')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [noteText, setNoteText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [targetListId, setTargetListId] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const listsQuery = useLists()
  const listOptions = useMemo(() => flattenForSelect(listsQuery.data || []), [listsQuery.data])

  const createBookmark = useCreateBookmark()
  const addBookmarkToList = useAddBookmarkToList()
  const attachTags = useAttachTags()
  const createFileBookmarks = useCreateFileBookmarks()

  const urlValid = mode === 'link' ? isLikelyUrl(url.trim()) : true
  const textValid = mode === 'text' ? noteText.trim().length > 0 : true
  const filesValid = mode === 'file' ? files.length > 0 : true
  const canSubmit = urlValid && textValid && filesValid && !busy

  async function submitFiles(tagNames: string[]): Promise<void> {
    const result = await createFileBookmarks(files, { listId: targetListId || undefined })
    if (tagNames.length > 0) {
      for (const bookmark of result.created) {
        await attachTags.mutateAsync({ bookmarkId: bookmark.id, tagNames })
      }
    }
    if (result.failed.length > 0) {
      // Stay open on a partial failure — closing would take the only
      // report of what didn't make it with it.
      setError(result.failed.map((f) => `${f.fileName}: ${f.message}`).join('\n'))
      setFiles(result.created.length > 0 ? [] : files)
      return
    }
    onClose()
  }

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

      if (mode === 'file') {
        await submitFiles(tagNames)
        return
      }

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
          {(['link', 'text', 'file'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              data-testid={`add-mode-${m}`}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium ${
                mode === m
                  ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100'
                  : 'text-neutral-500 dark:text-neutral-400'
              }`}
            >
              {m === 'link' ? 'URL' : m === 'text' ? 'Note' : 'File'}
            </button>
          ))}
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
        ) : mode === 'text' ? (
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
        ) : (
          <div className="mb-3 text-sm">
            <span className="mb-1 block text-neutral-600 dark:text-neutral-400">Files</span>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={FILE_ACCEPT}
              onChange={(e) => setFiles(Array.from(e.target.files || []))}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full rounded-lg border border-dashed border-neutral-300 px-3 py-4 text-sm text-neutral-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-neutral-700 dark:hover:border-emerald-500 dark:hover:text-emerald-400"
            >
              {files.length === 0
                ? 'Choose PDFs or images…'
                : `${files.length} file${files.length === 1 ? '' : 's'} selected — choose again to replace`}
            </button>
            {files.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {files.map((f) => (
                  <li key={`${f.name}-${f.size}`} className="truncate text-xs text-neutral-500">
                    {f.name} · {(f.size / 1024 / 1024).toFixed(1)} MB
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-neutral-400">
              You can also drop files straight onto the window.
            </p>
          </div>
        )}

        {/* No title field in file mode: a title box can only name one
            thing, and a multi-file import would silently apply it to all of
            them. Each file's bookmark takes its own file name instead, and
            the title is editable in the detail pane afterwards. */}
        <label className={`mb-3 block text-sm ${mode === 'file' ? 'hidden' : ''}`}>
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

        {error && <p className="mb-3 whitespace-pre-wrap text-sm text-red-600 dark:text-red-400">{error}</p>}

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
            {busy ? (mode === 'file' ? 'Uploading…' : 'Saving…') : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
