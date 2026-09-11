import type { CodeindexConfig } from '../config.js'
import type { IndexSummary } from '../indexer/index-codebase.js'
import { probeDirty } from './probe-dirty.js'
import type { WatcherStatus } from './tools.js'

export type SubmitReindex = (input: Readonly<{ mode: 'full' | 'incremental' }>) => Promise<IndexSummary>

/** Hourly probe-first reconcile for long-lived sessions that miss fs.watch events. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 3_600_000

export interface ReconcileState {
  status: WatcherStatus
  lastError: string | null
  lastCompletedAt: number | null
}

export interface ReconcileDeps {
  readonly config: CodeindexConfig
  readonly submit: SubmitReindex
  readonly state: ReconcileState
  readonly intervalMs: number
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Probe-first reconcile: fs.watch misses (rename storms, sleep, DB-side drift)
// accumulate without a process restart. Clean probe is a no-op; dirty submits one
// incremental through the shared scheduler.
export const runReconcileTick = async (deps: ReconcileDeps): Promise<void> => {
  try {
    if (await probeDirty(deps.config)) {
      await deps.submit({ mode: 'incremental' })
      deps.state.lastCompletedAt = Date.now()
      deps.state.lastError = null
      if (deps.state.status !== 'catching_up') {
        deps.state.status = 'idle'
      }
    }
  } catch (error) {
    deps.state.status = 'error'
    deps.state.lastError = errorMessage(error)
  }
}

export const startReconcileTimer = (deps: ReconcileDeps): ReturnType<typeof setInterval> =>
  setInterval(() => {
    void runReconcileTick(deps)
  }, deps.intervalMs)

export const stopReconcileTimer = (timer: ReturnType<typeof setInterval> | null): void => {
  if (timer !== null) {
    clearInterval(timer)
  }
}
