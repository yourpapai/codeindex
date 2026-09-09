import { existsSync, watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { CodeindexConfig } from '../config.js'
import { createIndexablePathFilter, discoverSourceFiles, type IndexablePathFilter } from '../indexer/discover.js'
import type { IndexSummary } from '../indexer/index-codebase.js'
import { openDatabase } from '../storage/db.js'
import type { IndexFreshnessState } from './freshness.js'
import type { ReindexMode } from './reindex-scheduler.js'
import type { WatcherState, WatcherStatus } from './tools.js'

export const DEFAULT_DEBOUNCE_MS = 300

// FSEvents replays changes that predate watch registration (~10 ms after start). Events
// are swallowed until the watcher is armed: the boot loop below converts that pre-watch
// state into probe truth instead of phantom catch-up runs.
const REPLAY_SETTLE_MS = 200

export interface IndexWatcher {
  readonly start: () => Promise<void>
  readonly stop: () => void
  readonly getState: () => WatcherState
  readonly getIndexFreshness: () => IndexFreshnessState
  readonly isArmed: () => boolean
}

export interface CreateWatcherOptions {
  readonly debounceMs?: number
}

interface StoredFileRow {
  readonly file_path: string
  readonly indexed_at: number
}

interface MutableWatcherState {
  status: WatcherStatus
  armed: boolean
  pendingEvents: number
  lastError: string | null
  lastCompletedAt: number | null
  catchUpRunning: boolean
}

type SubmitReindex = (input: Readonly<{ mode: ReindexMode }>) => Promise<IndexSummary>

interface WatcherContext {
  readonly state: MutableWatcherState
  readonly config: CodeindexConfig
  readonly submit: SubmitReindex
  readonly debounceMs: number
  filter: IndexablePathFilter | null
  fsWatcher: FSWatcher | null
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

// Boot probe: pure structure + mtime truth. discoverSourceFiles supplies the current
// file set; stored rows supply the indexed set and epoch-ms timestamps. No file reads,
// no hashing — the catch-up reindex itself re-derives content hashes. Missing or
// unreadable DB, dropped rows, or a mtime past the stored timestamp all mean drift.
const probeDirty = async (config: CodeindexConfig): Promise<boolean> => {
  const { files: discovered } = await discoverSourceFiles({
    repoRoot: config.repoRoot,
    roots: config.roots,
    exclude: config.exclude,
    languages: config.languages,
    maxFileSizeBytes: config.maxFileSizeBytes,
  })
  const discoveredPaths = new Set(discovered.map((file) => file.relativePath))
  if (!existsSync(config.dbPath)) {
    return true
  }
  const db = openDatabase(config.dbPath)
  try {
    let stored: readonly StoredFileRow[]
    try {
      stored = db.query<StoredFileRow, []>('SELECT file_path, indexed_at FROM files').all()
    } catch {
      return true
    }
    const storedPaths = new Set(stored.map((row) => row.file_path))
    for (const discoveredPath of discoveredPaths) {
      if (!storedPaths.has(discoveredPath)) {
        return true
      }
    }
    const mtimeDrift = await Promise.all(
      stored.map(async (row): Promise<boolean> => {
        if (!discoveredPaths.has(row.file_path)) {
          return true
        }
        try {
          const mtimeMs = (await stat(path.join(config.repoRoot, row.file_path))).mtimeMs
          return !(mtimeMs <= row.indexed_at)
        } catch {
          return true
        }
      }),
    )
    return mtimeDrift.some((drift) => drift)
  } finally {
    db.close()
  }
}

// Drain pending events into at most one incremental run at a time; events that arrive
// while a run is active keep the drain alive. Failure records state and stops the
// drain — the next triggering event retries through the debounced path.
const runCatchUp = async (state: MutableWatcherState, submit: SubmitReindex, initialSubmit: boolean): Promise<void> => {
  if (!initialSubmit && state.pendingEvents === 0) {
    state.status = 'idle'
    return
  }
  state.pendingEvents = 0
  state.status = 'catching_up'
  try {
    await submit({ mode: 'incremental' })
    state.lastCompletedAt = Date.now()
    state.lastError = null
  } catch (error) {
    state.status = 'error'
    state.lastError = errorMessage(error)
    return
  }
  return runCatchUp(state, submit, false)
}

const startCatchUp = (context: WatcherContext, initialSubmit: boolean): void => {
  if (context.state.catchUpRunning) {
    return
  }
  context.state.catchUpRunning = true
  void runCatchUp(context.state, context.submit, initialSubmit).finally(() => {
    context.state.catchUpRunning = false
  })
}

const scheduleDebounce = (context: WatcherContext): void => {
  // Reset-on-event debounce: a burst of events inside the window collapses into one
  // timer fire, so one catch-up covers the whole burst.
  if (context.debounceTimer !== null) {
    clearTimeout(context.debounceTimer)
  }
  context.debounceTimer = setTimeout(() => {
    context.debounceTimer = null
    startCatchUp(context, false)
  }, context.debounceMs)
}

const onWatchEvent = (context: WatcherContext, filename: string | null): void => {
  if (filename === null) {
    return
  }
  if (!context.state.armed || context.filter === null) {
    return
  }
  if (!context.filter.isIndexable(filename)) {
    return
  }
  context.state.pendingEvents += 1
  scheduleDebounce(context)
}

// Boot sequence: swallow events, reconcile via probe/catch-up until clean, then arm.
// A failed initial catch-up still arms — the next triggering event retries through the
// normal debounced path, and status stays 'error' until a run succeeds.
const bootWatcher = async (context: WatcherContext): Promise<void> => {
  const { config, state, submit } = context
  if (await probeDirty(config)) {
    state.status = 'catching_up'
    try {
      await submit({ mode: 'incremental' })
      state.lastCompletedAt = Date.now()
      state.lastError = null
      state.status = 'idle'
    } catch (error) {
      state.status = 'error'
      state.lastError = errorMessage(error)
      state.armed = true
      return
    }
  }
  await delay(REPLAY_SETTLE_MS)
  if (await probeDirty(config)) {
    return bootWatcher(context)
  }
  state.status = 'idle'
  state.armed = true
}

const startWatcher = async (context: WatcherContext): Promise<void> => {
  context.filter = await createIndexablePathFilter({
    repoRoot: context.config.repoRoot,
    roots: context.config.roots,
    exclude: context.config.exclude,
    languages: context.config.languages,
    maxFileSizeBytes: context.config.maxFileSizeBytes,
  })
  context.fsWatcher = watch(context.config.repoRoot, { recursive: true }, (_eventType, filename): void => {
    onWatchEvent(context, filename)
  })
  await bootWatcher(context)
}

const stopWatcher = (context: WatcherContext): void => {
  if (context.debounceTimer !== null) {
    clearTimeout(context.debounceTimer)
    context.debounceTimer = null
  }
  context.fsWatcher?.close()
  context.fsWatcher = null
}

// Watcher-lite for the stdio MCP server: a boot probe that catch-up reindexes a dirty
// index, and an in-session fs.watch that debounces event bursts into incremental
// catch-ups submitted through the shared scheduler. State is the single source the
// response-level indexFreshness field and code_index reporting read. Missed events
// are reconciled by the next session's boot probe — no daemon, no reconcile timer.
export const createWatcher = (
  config: CodeindexConfig,
  submit: SubmitReindex,
  options: Readonly<CreateWatcherOptions> = {},
): IndexWatcher => {
  const context: WatcherContext = {
    state: {
      status: 'idle',
      armed: false,
      pendingEvents: 0,
      lastError: null,
      lastCompletedAt: null,
      catchUpRunning: false,
    },
    config,
    submit,
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    filter: null,
    fsWatcher: null,
    debounceTimer: null,
  }
  return {
    start: (): Promise<void> => startWatcher(context),
    stop: (): void => {
      stopWatcher(context)
    },
    getState: (): WatcherState => ({
      status: context.state.status,
      pendingEvents: context.state.pendingEvents,
      lastError: context.state.lastError,
      lastCompletedAt: context.state.lastCompletedAt,
    }),
    isArmed: (): boolean => context.state.armed,
    getIndexFreshness: (): IndexFreshnessState => ({
      indexFreshness: context.state.armed && context.state.status === 'idle' ? 'fresh' : 'possibly_stale',
    }),
  }
}
