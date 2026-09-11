import type { IndexSummary } from '../indexer/index-codebase.js'

export type ReindexMode = 'full' | 'incremental'

export interface ReindexScheduler {
  readonly submit: (input: Readonly<{ mode: ReindexMode }>) => Promise<IndexSummary>
  readonly isBusy: () => boolean
  /** Await the current run and any coalesced follow-up without enqueueing another. */
  readonly whenSettled: () => Promise<void>
}

interface Waiter {
  readonly resolve: (summary: IndexSummary) => void
  readonly reject: (error: unknown) => void
}

interface SchedulerState {
  busy: boolean
  pendingHasFull: boolean
  pendingWaiters: Waiter[]
  idleWaiters: Array<() => void>
}

type ExecuteRun = (mode: ReindexMode, waiters: readonly Waiter[]) => Promise<void>

const notifyIdle = (state: SchedulerState): void => {
  if (state.busy || state.pendingWaiters.length > 0) {
    return
  }
  const waiting = state.idleWaiters
  state.idleWaiters = []
  for (const waiter of waiting) {
    waiter()
  }
}

const drainPending = (state: SchedulerState, execute: ExecuteRun): void => {
  if (state.pendingWaiters.length === 0) {
    notifyIdle(state)
    return
  }
  const followUpMode = state.pendingHasFull ? 'full' : 'incremental'
  const followUpWaiters = state.pendingWaiters
  state.pendingWaiters = []
  state.pendingHasFull = false
  void execute(followUpMode, followUpWaiters)
}

const createExecute = (
  state: SchedulerState,
  run: (input: Readonly<{ mode: ReindexMode }>) => Promise<IndexSummary>,
): ExecuteRun => {
  const execute: ExecuteRun = async (mode, waiters) => {
    state.busy = true
    try {
      const summary = await run({ mode })
      for (const waiter of waiters) {
        waiter.resolve(summary)
      }
    } catch (error) {
      for (const waiter of waiters) {
        waiter.reject(error)
      }
    } finally {
      state.busy = false
      drainPending(state, execute)
    }
  }
  return execute
}

// Serializes every indexing run for the process: agent-triggered code_index and
// watcher-triggered catch-ups share this one queue, so at most one run is active
// at any time. Triggers arriving during an active run coalesce into a single
// follow-up — the incremental path re-derives what changed at execution time, so
// nothing stale is ever queued, only the fact that a run was requested.
export const createReindexScheduler = (
  run: (input: Readonly<{ mode: ReindexMode }>) => Promise<IndexSummary>,
): ReindexScheduler => {
  const state: SchedulerState = {
    busy: false,
    pendingHasFull: false,
    pendingWaiters: [],
    idleWaiters: [],
  }
  const execute = createExecute(state, run)

  const submit = (input: Readonly<{ mode: ReindexMode }>): Promise<IndexSummary> =>
    new Promise<IndexSummary>((resolve, reject) => {
      if (state.busy) {
        state.pendingHasFull = state.pendingHasFull || input.mode === 'full'
        state.pendingWaiters.push({ resolve, reject })
      } else {
        void execute(input.mode, [{ resolve, reject }])
      }
    })

  const whenSettled = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!state.busy && state.pendingWaiters.length === 0) {
        resolve()
        return
      }
      state.idleWaiters.push(resolve)
    })

  return {
    submit,
    isBusy: (): boolean => state.busy,
    whenSettled,
  }
}
