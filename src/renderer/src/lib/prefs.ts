import { useCallback, useEffect, useState } from 'react'

/**
 * View-only chrome state: pane widths, collapse flags, density, sort,
 * theme, last selection.
 *
 * This is deliberately *not* in main/store.ts. That file holds real user
 * data synced over IPC (credentials, listOrder); this is how the window
 * happened to be arranged. Keeping it in localStorage means it can be read
 * synchronously during the first render, so the layout is correct on the
 * very first paint — an async IPC round-trip would render the panes at
 * their defaults and then visibly snap to the stored size a frame later,
 * on every single launch.
 *
 * Every read is defensive: localStorage throws in some sandboxed contexts,
 * and a value written by an older build may no longer parse. A preference
 * that can't be read is not worth crashing the window over, so failures
 * fall back to the default and the app carries on without persistence.
 */

const NS = 'kk:'

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(NS + key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writePref<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(NS + key, JSON.stringify(value))
  } catch {
    // Preference just won't survive the launch. Harmless.
  }
}

/**
 * `useState` that persists. The initialiser reads storage lazily so the
 * very first render already has the stored value.
 */
export function usePref<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback))

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        writePref(key, resolved)
        return resolved
      })
    },
    [key]
  )

  return [value, set]
}

/**
 * A set of ids stored as an array. Used for "which sidebar sections are
 * collapsed" and "which list nodes are expanded", where the natural shape
 * is a Set but JSON only has arrays.
 */
export function usePrefSet(key: string, fallback: string[] = []): {
  has: (id: string) => boolean
  toggle: (id: string) => void
  set: (id: string, on: boolean) => void
} {
  const [ids, setIds] = usePref<string[]>(key, fallback)

  const has = useCallback((id: string) => ids.includes(id), [ids])

  const set = useCallback(
    (id: string, on: boolean) => {
      setIds((prev) => (on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)))
    },
    [setIds]
  )

  const toggle = useCallback(
    (id: string) => {
      setIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
    },
    [setIds]
  )

  return { has, toggle, set }
}

// ───────────────────────────── Theme ─────────────────────────────

export type ThemePref = 'system' | 'light' | 'dark'

/**
 * Tailwind is configured `darkMode: 'class'`, so the stylesheet follows
 * whatever `.dark` says rather than the OS directly. That's what makes an
 * in-app override possible at all — under `darkMode: 'media'` the app
 * could only ever mirror the system setting.
 *
 * 'system' is still the default, and it stays *live*: the
 * matchMedia listener means changing the OS appearance while the app is
 * open flips it immediately, exactly as `media` used to.
 */
export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  root.classList.toggle('dark', dark)
}

export function useTheme(): [ThemePref, (next: ThemePref) => void] {
  const [pref, setPref] = usePref<ThemePref>('theme', 'system')

  useEffect(() => {
    applyTheme(pref)
    if (pref !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [pref])

  return [pref, setPref]
}
