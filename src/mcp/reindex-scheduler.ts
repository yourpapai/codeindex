import type { IndexSummary } from '../indexer/index-codebase.js'

export type ReindexMode = 'full' | 'incremental'

export interface ReindexScheduler {
  readonly submit: (input: Readonly<{ mode: ReindexMode }>) => Promise<IndexSummary>
  readonly isBusy: () => boolean
}

interface Waiter {
  readonly resolve: (summary: IndexSummary) => void
  readonly reject: (error: unknown) => void
}

// Serializes every indexing run for the process: agent-triggered code_index and
// watcher-triggered catch-ups share this one queue, so at most one run is active
// at any time. Triggers arriving during an active run coalesce into a single
// follow-up — the incremental path re-derives what changed at execution time, so
// nothing stale is ever queued, only the fact that a run was requested.
export const createReindexScheduler = (
  run: (input: Readonly<{ mode: ReindexMode }>) => Promise<IndexSummary>,
): ReindexScheduler => {
  let busy = false
  let pendingHasFull = false
  let pendingWaiters: Waiter[] = []

  const execute = async (mode: ReindexMode, waiters: readonly Waiter[]): Promise<void> => {
    busy = true
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
      busy = false
      if (pendingWaiters.length > 0) {
        const followUpMode = pendingHasFull ? 'full' : 'incremental'
        const followUpWaiters = pendingWaiters
        pendingWaiters = []
        pendingHasFull = false
        void execute(followUpMode, followUpWaiters)
      }
    }
  }

  const submit = (input: Readonly<{ mode: ReindexMode }>): Promise<IndexSummary> =>
    new Promise<IndexSummary>((resolve, reject) => {
      if (busy) {
        pendingHasFull = pendingHasFull || input.mode === 'full'
        pendingWaiters.push({ resolve, reject })
      } else {
        void execute(input.mode, [{ resolve, reject }])
      }
    })

  return {
    submit,
    isBusy: (): boolean => busy,
  }
}
