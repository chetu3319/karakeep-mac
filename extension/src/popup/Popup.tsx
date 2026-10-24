import React, { useCallback, useEffect, useMemo, useState } from 'react'
import Icon from '../../../src/renderer/src/components/Icon'
import { hexForColor } from '../../../src/shared/highlightUi'
import type { Bookmark, Highlight, KKList } from '../../../src/shared/types'
import { send, type PopupState } from '../messages'
import { bookmarkWebUrl } from '../settings'

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const isMac = /Mac/i.test(navigator.platform)
const SHORTCUT = isMac ? '⌥⇧H' : 'Alt+Shift+H'

async function resolveTabId(): Promise<number> {
  // ?tabId= lets the popup be opened as a page against a given tab (the
  // end-to-end harness does this); normally it describes the active tab.
  const fromQuery = Number(new URLSearchParams(location.search).get('tabId'))
  if (fromQuery) return fromQuery
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab')
  return tab.id
}

export default function Popup(): React.JSX.Element {
  const [tabId, setTabId] = useState<number | null>(null)
  const [state, setState] = useState<PopupState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (id: number) => {
    setError(null)
    try {
      setState(await send<PopupState>({ type: 'popup:state', tabId: id }))
    } catch (err) {
      setError(errMessage(err))
    }
  }, [])

  useEffect(() => {
    resolveTabId().then(
      (id) => {
        setTabId(id)
        void load(id)
      },
      (err) => setError(errMessage(err))
    )
  }, [load])

  async function save(): Promise<void> {
    if (tabId === null) return
    setSaving(true)
    setError(null)
    try {
      setState(await send<PopupState>({ type: 'bookmark:save', tabId }))
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex max-h-[600px] min-h-[220px] w-[380px] flex-col">
      <header className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
        <img src="icons/icon-32.png" alt="" className="h-5 w-5 rounded" />
        <span className="text-sm font-semibold">Karakeep</span>
        <div className="flex-1" />
        <button
          type="button"
          title="Settings"
          aria-label="Settings"
          onClick={() => void chrome.runtime.openOptionsPage()}
          className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <Icon name="settings" size={16} />
        </button>
      </header>

      <main className="flex-1 overflow-y-auto">
        {error && !state ? (
          <ErrorBox message={error} onRetry={() => tabId !== null && void load(tabId)} />
        ) : !state ? (
          <Skeleton />
        ) : !state.configured ? (
          <NotConfigured />
        ) : !state.tab.savable ? (
          <p className="px-6 py-10 text-center text-sm text-neutral-500">Karakeep can’t save this kind of page.</p>
        ) : state.bookmark ? (
          <SavedView state={state} onChange={setState} onReload={() => void load(state.tab.id)} />
        ) : (
          <UnsavedView state={state} saving={saving} error={error} onSave={() => void save()} />
        )}
      </main>

      {state?.user && (
        <footer className="flex items-center gap-1.5 border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-400 dark:border-neutral-800">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <span className="truncate">
            {state.user.name || state.user.email} · {hostOf(state.baseUrl)}
          </span>
        </footer>
      )}
    </div>
  )
}

function Skeleton(): React.JSX.Element {
  return (
    <div className="space-y-3 p-4" aria-hidden>
      <div className="h-4 w-3/4 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
      <div className="h-3 w-1/3 animate-pulse rounded bg-neutral-200/70 dark:bg-neutral-800" />
      <div className="h-9 animate-pulse rounded-lg bg-neutral-200/70 dark:bg-neutral-800" />
    </div>
  )
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="p-4">
      <p className="mb-3 text-sm text-red-600 dark:text-red-400">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        Try again
      </button>
    </div>
  )
}

function NotConfigured(): React.JSX.Element {
  return (
    <div className="px-6 py-8 text-center">
      <h1 className="mb-1 text-base font-semibold">Connect to Karakeep</h1>
      <p className="mb-5 text-sm text-neutral-500">Add your server address and an API key to start saving pages.</p>
      <button
        type="button"
        onClick={() => void chrome.runtime.openOptionsPage()}
        className="w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        Open settings
      </button>
    </div>
  )
}

function PageCard({ title, url, favIconUrl }: { title: string; url: string; favIconUrl?: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
        {favIconUrl ? <img src={favIconUrl} alt="" className="h-4 w-4" /> : <Icon name="library" size={15} className="text-neutral-400" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-sm font-medium leading-snug text-neutral-900 dark:text-neutral-100">{title}</div>
        <div className="mt-0.5 truncate text-xs text-neutral-500">{hostOf(url)}</div>
      </div>
    </div>
  )
}

function Tip(): React.JSX.Element {
  return (
    <div className="flex gap-2.5 rounded-lg bg-neutral-50 px-3 py-2.5 text-xs leading-relaxed text-neutral-500 dark:bg-neutral-900">
      <Icon name="highlight" size={15} className="mt-0.5 shrink-0 text-neutral-400" />
      <span>
        To highlight, select text, right-click and choose <b className="font-medium text-neutral-700 dark:text-neutral-300">Highlight with Karakeep</b>
        , or press <kbd className="rounded border border-neutral-300 px-1 font-sans dark:border-neutral-700">{SHORTCUT}</kbd>.
      </span>
    </div>
  )
}

function UnsavedView({
  state,
  saving,
  error,
  onSave
}: {
  state: PopupState
  saving: boolean
  error: string | null
  onSave: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-4 p-4">
      <PageCard title={state.tab.title} url={state.tab.url} favIconUrl={state.tab.favIconUrl} />
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        <Icon name="plus" size={15} />
        {saving ? 'Saving…' : 'Save to Karakeep'}
      </button>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <Tip />
    </div>
  )
}

function IconButton({
  icon,
  label,
  active,
  danger,
  onClick
}: {
  icon: React.ComponentProps<typeof Icon>['name']
  label: string
  active?: boolean
  danger?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
        active ? 'text-amber-500' : danger ? 'text-neutral-500 hover:text-red-600' : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
      }`}
    >
      <Icon name={icon} size={16} />
    </button>
  )
}

function SavedView({
  state,
  onChange,
  onReload
}: {
  state: PopupState
  onChange: (s: PopupState) => void
  onReload: () => void
}): React.JSX.Element {
  const bookmark = state.bookmark as Bookmark
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const patch = (next: Partial<PopupState>): void => onChange({ ...state, ...next })

  async function run<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    setError(null)
    try {
      return await fn()
    } catch (err) {
      setError(`Couldn't ${what}. ${errMessage(err)}`)
      return undefined
    }
  }

  async function toggle(field: 'favourited' | 'archived'): Promise<void> {
    const updated = await run('update the bookmark', () =>
      send<Bookmark>({ type: 'bookmark:update', tabId: state.tab.id, id: bookmark.id, patch: { [field]: !bookmark[field] } })
    )
    if (updated) patch({ bookmark: { ...bookmark, ...updated } })
  }

  async function remove(): Promise<void> {
    const ok = await run('delete the bookmark', () => send({ type: 'bookmark:delete', tabId: state.tab.id, id: bookmark.id }))
    if (ok !== undefined) onReload()
  }

  const title = bookmark.title || bookmark.content?.title || state.tab.title

  return (
    <div>
      <div className="space-y-3 p-4 pb-3">
        <div className="flex items-center gap-1">
          <span className="flex items-center gap-1 rounded-full bg-emerald-50 py-0.5 pl-1.5 pr-2 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
            <Icon name="check" size={12} />
            Saved
          </span>
          <div className="flex-1" />
          <IconButton
            icon={bookmark.favourited ? 'star-filled' : 'star'}
            label={bookmark.favourited ? 'Remove from favourites' : 'Favourite'}
            active={bookmark.favourited}
            onClick={() => void toggle('favourited')}
          />
          <IconButton
            icon="archive"
            label={bookmark.archived ? 'Unarchive' : 'Archive'}
            active={bookmark.archived}
            onClick={() => void toggle('archived')}
          />
          <IconButton
            icon="external"
            label="Open in Karakeep"
            onClick={() => void chrome.tabs.create({ url: bookmarkWebUrl(state.baseUrl, bookmark.id) })}
          />
          <IconButton icon="trash" label="Delete bookmark" danger onClick={() => setConfirmDelete(true)} />
        </div>

        {confirmDelete && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
            <span className="flex-1">Delete this bookmark and its highlights?</span>
            <button type="button" onClick={() => setConfirmDelete(false)} className="rounded px-2 py-1 hover:bg-red-100 dark:hover:bg-red-900">
              Cancel
            </button>
            <button type="button" onClick={() => void remove()} className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700">
              Delete
            </button>
          </div>
        )}

        <PageCard title={title} url={state.tab.url} favIconUrl={state.tab.favIconUrl} />

        <TagEditor state={state} onChange={onChange} onError={setError} />
        <ListMembership state={state} onChange={onChange} onError={setError} />
        <NoteEditor state={state} onChange={onChange} onError={setError} />

        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>

      <HighlightsSection state={state} onChange={onChange} onError={setError} />
    </div>
  )
}

interface SectionProps {
  state: PopupState
  onChange: (s: PopupState) => void
  onError: (e: string | null) => void
}

function TagEditor({ state, onChange, onError }: SectionProps): React.JSX.Element {
  const bookmark = state.bookmark as Bookmark
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const attached = bookmark.tags || []
  const attachedNames = useMemo(() => new Set(attached.map((t) => t.name.toLowerCase())), [attached])
  const suggestions = state.tags.filter((t) => !attachedNames.has(t.name.toLowerCase()))

  async function mutate(type: 'tags:attach' | 'tags:detach', names: string[]): Promise<void> {
    onError(null)
    try {
      const updated = await send<Bookmark>({ type, id: bookmark.id, names })
      onChange({ ...state, bookmark: updated })
    } catch (err) {
      onError(`Couldn't ${type === 'tags:attach' ? 'add' : 'remove'} the tag. ${errMessage(err)}`)
    }
  }

  function commit(): void {
    const names = draft
      .split(',')
      .map((t) => t.trim())
      .filter((n) => n && !attachedNames.has(n.toLowerCase()))
    setDraft('')
    setAdding(false)
    if (names.length) void mutate('tags:attach', names)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {attached.map((t) => (
        <span
          key={t.id}
          className="flex items-center gap-1 rounded-full bg-neutral-100 py-0.5 pl-2 pr-1 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
        >
          #{t.name}
          <button
            type="button"
            onClick={() => void mutate('tags:detach', [t.name])}
            aria-label={`Remove tag ${t.name}`}
            className="rounded-full px-1 text-neutral-400 hover:bg-neutral-200 hover:text-red-600 dark:hover:bg-neutral-700"
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
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setDraft('')
                setAdding(false)
              }
            }}
            placeholder="tag name"
            className="w-32 rounded-full border border-emerald-500 bg-transparent px-2 py-0.5 text-xs outline-none"
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
          className="rounded-full border border-dashed border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-neutral-700"
        >
          + Tag
        </button>
      )}
    </div>
  )
}

function ListMembership({ state, onChange, onError }: SectionProps): React.JSX.Element | null {
  const bookmark = state.bookmark as Bookmark
  const memberIds = new Set(state.bookmarkLists.map((l) => l.id))
  // Smart lists are queries; a bookmark can't be put into one by hand.
  const addable = state.lists.filter((l) => l.type !== 'smart' && !memberIds.has(l.id))
  if (!state.lists.length) return null

  async function mutate(type: 'lists:add' | 'lists:remove', list: KKList): Promise<void> {
    onError(null)
    try {
      const bookmarkLists = await send<KKList[]>({ type, listId: list.id, id: bookmark.id })
      onChange({ ...state, bookmarkLists })
    } catch (err) {
      onError(`Couldn't update “${list.name}”. ${errMessage(err)}`)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {state.bookmarkLists.map((l) => (
        <span
          key={l.id}
          className="flex items-center gap-1 rounded-md bg-sky-50 py-0.5 pl-1.5 pr-1 text-xs text-sky-700 dark:bg-sky-950 dark:text-sky-300"
        >
          <span aria-hidden>{l.icon || '📁'}</span>
          {l.name}
          {l.type !== 'smart' && (
            <button
              type="button"
              onClick={() => void mutate('lists:remove', l)}
              aria-label={`Remove from ${l.name}`}
              className="rounded px-1 text-sky-400 hover:bg-sky-100 hover:text-red-600 dark:hover:bg-sky-900"
            >
              ×
            </button>
          )}
        </span>
      ))}
      {addable.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            const list = addable.find((l) => l.id === e.target.value)
            if (list) void mutate('lists:add', list)
          }}
          aria-label="Add to list"
          className="rounded-md border border-dashed border-neutral-300 bg-transparent px-1.5 py-0.5 text-xs text-neutral-500 outline-none hover:border-emerald-500 dark:border-neutral-700"
        >
          <option value="">+ List</option>
          {addable.map((l) => (
            <option key={l.id} value={l.id}>
              {l.icon ? `${l.icon} ` : ''}
              {l.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

function NoteEditor({ state, onChange, onError }: SectionProps): React.JSX.Element {
  const bookmark = state.bookmark as Bookmark
  const [draft, setDraft] = useState(bookmark.note || '')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  async function commit(): Promise<void> {
    if ((bookmark.note || '') === draft) return
    setStatus('saving')
    onError(null)
    try {
      const updated = await send<Bookmark>({ type: 'bookmark:update', tabId: state.tab.id, id: bookmark.id, patch: { note: draft } })
      onChange({ ...state, bookmark: { ...bookmark, ...updated } })
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 1500)
    } catch (err) {
      setStatus('idle')
      onError(`Couldn't save the note. ${errMessage(err)}`)
    }
  }

  return (
    <div className="relative">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        placeholder="Add a note…"
        rows={draft ? 3 : 1}
        className="w-full resize-none rounded-lg border border-neutral-200 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-emerald-500 dark:border-neutral-800"
      />
      {status !== 'idle' && (
        <span className="absolute bottom-2.5 right-2.5 text-[11px] text-neutral-400">{status === 'saving' ? 'Saving…' : 'Saved'}</span>
      )}
    </div>
  )
}

function HighlightsSection({ state, onChange, onError }: SectionProps): React.JSX.Element {
  const highlights = [...state.highlights].sort((a, b) => a.startOffset - b.startOffset)

  function focus(h: Highlight): void {
    void chrome.tabs.sendMessage(state.tab.id, { type: 'kk:focus', id: h.id }).catch(() => undefined)
  }

  async function remove(h: Highlight): Promise<void> {
    onError(null)
    try {
      await send({ type: 'popup:delete-highlight', tabId: state.tab.id, id: h.id })
      onChange({ ...state, highlights: state.highlights.filter((x) => x.id !== h.id) })
    } catch (err) {
      onError(`Couldn't delete the highlight. ${errMessage(err)}`)
    }
  }

  return (
    <section className="border-t border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center gap-1.5 px-4 pb-1 pt-3 text-xs font-medium text-neutral-500">
        <Icon name="highlight" size={14} className="text-neutral-400" />
        Highlights
        <span className="tabular-nums text-neutral-400">{highlights.length}</span>
      </div>
      {highlights.length === 0 ? (
        <div className="px-4 pb-4 pt-1">
          <Tip />
        </div>
      ) : (
        <ul className="pb-2">
          {highlights.map((h) => (
            <li key={h.id} className="group relative">
              <button
                type="button"
                onClick={() => focus(h)}
                title="Show on the page"
                className="flex w-full gap-2.5 px-4 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                <span className="w-1 shrink-0 self-stretch rounded-full" style={{ backgroundColor: hexForColor(h.color) }} />
                <span className="min-w-0 flex-1 pr-6">
                  <span className="line-clamp-3 text-[13px] leading-snug text-neutral-800 dark:text-neutral-200">
                    {h.text || <em className="text-neutral-400">(no text captured)</em>}
                  </span>
                  {h.note && (
                    <span className="mt-1 line-clamp-2 text-xs leading-snug text-neutral-500 dark:text-neutral-400">{h.note}</span>
                  )}
                </span>
              </button>
              <button
                type="button"
                onClick={() => void remove(h)}
                aria-label="Delete highlight"
                title="Delete highlight"
                className="absolute right-3 top-2 rounded p-1 text-neutral-400 opacity-0 hover:bg-neutral-200 hover:text-red-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-800"
              >
                <Icon name="trash" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
