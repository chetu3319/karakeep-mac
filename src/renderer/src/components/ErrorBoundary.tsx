import React from 'react'

/**
 * Stops one broken pane from taking the window with it.
 *
 * There was no error boundary anywhere in this app, which means React's
 * default applied: any error thrown while rendering unmounts the *entire*
 * tree. In a dark-themed Electron window that is indistinguishable from a
 * crash — the window simply goes black, with the real error visible only
 * in a devtools console nobody has open.
 *
 * The reader panes are where this bites: they drive a wasm PDF engine and
 * a native web view through a lot of asynchronous state, and a single bad
 * render there should cost you the pane, not the library, the sidebar and
 * everything you had open.
 *
 * `resetKey` clears a caught error when it changes — selecting a different
 * bookmark should get you a working pane again rather than a permanent
 * gravestone until the app is restarted.
 */
export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode; label: string; resetKey?: string | null },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep the stack somewhere a bug report can reach it. The renderer's
    // console is forwarded to the terminal under the smoke harness, and is
    // in devtools otherwise.
    console.error(`[${this.props.label}] render failed`, error, info.componentStack)
  }

  componentDidUpdate(prev: { resetKey?: string | null }): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
          Something went wrong in {this.props.label}.
        </p>
        <p className="max-w-md break-words text-xs text-neutral-500">{error.message || String(error)}</p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Try again
        </button>
        <p className="text-[11px] text-neutral-400">Selecting another bookmark also clears this.</p>
      </div>
    )
  }
}
