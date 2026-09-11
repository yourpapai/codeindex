import type { CodeindexConfig } from '../config.js'
import type { IndexSummary } from '../indexer/index-codebase.js'
import { probeDirty } from './probe-dirty.js'
import type { ReindexMode } from './reindex-scheduler.js'
import type { CodeindexToolDeps, WatcherState } from './tools.js'
import { DEFAULT_DEBOUNCE_MS } from './watcher.js'

export type SubmitReindex = (input: Readonly<{ mode: ReindexMode }>) => Promise<IndexSummary>

/** Bounded wait for incremental catch-up; on expiry the query still runs with honest marks. */
export const WAIT_REFRESH_TIMEOUT_MS = 10_000

export interface RefreshOptions {
  readonly submit: SubmitReindex
  readonly getWatcherState?: () => WatcherState
  readonly timeoutMs?: number
  /** Await an active scheduler run without enqueueing another. Falls back to submit join. */
  readonly whenSettled?: () => Promise<void>
}

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

// Wait path: settle any in-flight watcher work, probe drift, submit at most one
// incremental through the shared scheduler, then let the original query run.
// Never issues a full reindex. Bounded by timeoutMs so a slow catch-up cannot
// hang the query — the caller proceeds with current (possibly stale) results.
const catchUpIfDirty = async (config: CodeindexConfig, options: RefreshOptions): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? WAIT_REFRESH_TIMEOUT_MS
  const catchUp = async (): Promise<void> => {
    const state = options.getWatcherState?.()
    if (state?.status === 'catching_up') {
      // Join the active run without forcing an extra sequential follow-up when possible.
      const join = options.whenSettled
      if (join) {
        await join()
      } else {
        await options.submit({ mode: 'incremental' })
      }
    } else if ((state?.pendingEvents ?? 0) > 0) {
      await delay(DEFAULT_DEBOUNCE_MS)
    }
    if (await probeDirty(config)) {
      await options.submit({ mode: 'incremental' })
    }
  }
  const catchUpPromise = catchUp()
  await Promise.race([catchUpPromise, delay(timeoutMs).then(() => undefined)])
  // If the race lost to the timeout, keep a late catch-up rejection from becoming unhandled.
  void catchUpPromise.catch(() => undefined)
}

// Wraps the three query deps so `refresh: "wait"` can run catch-up before the
// query. Default/background and off take the original path with no probe/submit.
export const withRefresh = (
  deps: Readonly<CodeindexToolDeps>,
  config: CodeindexConfig,
  options: RefreshOptions,
): CodeindexToolDeps => ({
  codeSearch: async (
    input: Parameters<CodeindexToolDeps['codeSearch']>[0],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeSearch']>>> => {
    if (input.refresh === 'wait') {
      await catchUpIfDirty(config, options)
    }
    return deps.codeSearch(input)
  },
  codeSymbol: async (
    query: Parameters<CodeindexToolDeps['codeSymbol']>[0],
    limit: Parameters<CodeindexToolDeps['codeSymbol']>[1],
    refresh: Parameters<CodeindexToolDeps['codeSymbol']>[2],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeSymbol']>>> => {
    if (refresh === 'wait') {
      await catchUpIfDirty(config, options)
    }
    return deps.codeSymbol(query, limit, refresh)
  },
  codeImpact: async (
    input: Parameters<CodeindexToolDeps['codeImpact']>[0],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeImpact']>>> => {
    if (input.refresh === 'wait') {
      await catchUpIfDirty(config, options)
    }
    return deps.codeImpact(input)
  },
  codeOutline: async (
    input: Parameters<CodeindexToolDeps['codeOutline']>[0],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeOutline']>>> => {
    if (input.refresh === 'wait') {
      await catchUpIfDirty(config, options)
    }
    return deps.codeOutline(input)
  },
  codeIndex: deps.codeIndex,
  getIndexFreshness: deps.getIndexFreshness,
  getWatcherState: deps.getWatcherState,
  logResponseBytes: deps.logResponseBytes,
})
