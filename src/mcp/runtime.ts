import type { Database } from 'bun:sqlite'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { CodeindexConfig } from '../config.js'
import { indexCodebase } from '../indexer/index-codebase.js'
import { findSymbolCandidates, resolveIncomingReferences, searchSymbols } from '../search/index.js'
import { outlineFile } from '../search/outline.js'
import { openDatabase } from '../storage/db.js'
import { ensureSchema } from '../storage/schema.js'
import { withFreshness, type IndexFreshnessState } from './freshness.js'
import { withQueryLogging } from './query-logging.js'
import { withRefresh } from './refresh.js'
import { createReindexScheduler, type ReindexScheduler } from './reindex-scheduler.js'
import { createCodeindexServer } from './server.js'
import type { OutlineToolOutcome } from './tools.js'
import { createWatcher, type IndexWatcher } from './watcher.js'

// Neutral until the watcher (§4) supplies live catch-up state; the wrapper's
// per-hit marks work identically either way.
const neutralFreshnessState: IndexFreshnessState = { indexFreshness: 'fresh' }

export interface McpComponents {
  readonly scheduler?: ReindexScheduler
  readonly watcher?: IndexWatcher
}

const withDatabase = <T>(config: CodeindexConfig, callback: (db: Database) => T): T => {
  const db = openDatabase(config.dbPath)
  try {
    return callback(db)
  } finally {
    db.close()
  }
}

const buildQueryDeps = (
  config: CodeindexConfig,
  scheduler: ReindexScheduler,
): Omit<Parameters<typeof withFreshness>[0], 'getWatcherState' | 'logResponseBytes' | 'getIndexFreshness'> => ({
  codeSearch: (input: {
    query: string
    limit: number
    mode?: Parameters<typeof searchSymbols>[1]['mode']
    kinds?: readonly string[]
    scopeTiers?: Parameters<typeof searchSymbols>[1]['scopeTiers']
    pathPrefix?: string
    refresh?: 'background' | 'wait' | 'off'
  }): Promise<ReturnType<typeof searchSymbols>> => {
    const { refresh: _refresh, ...searchInput } = input
    return Promise.resolve(withDatabase(config, (db) => searchSymbols(db, searchInput)))
  },
  codeSymbol: (query: string, limit: number): Promise<ReturnType<typeof findSymbolCandidates>> =>
    Promise.resolve(withDatabase(config, (db) => findSymbolCandidates(db, query, limit))),
  codeImpact: (
    input: Parameters<typeof resolveIncomingReferences>[1] & {
      refresh?: 'background' | 'wait' | 'off'
    },
  ): Promise<ReturnType<typeof resolveIncomingReferences>> => {
    const { refresh: _refresh, ...impactInput } = input
    return Promise.resolve(withDatabase(config, (db) => resolveIncomingReferences(db, impactInput)))
  },
  codeOutline: (input: {
    filePath: string
    mode: 'symbols' | 'exports'
    limit: number
    scopeTiers?: readonly ('exported' | 'module' | 'member' | 'local')[]
    kinds?: readonly string[]
    refresh?: 'background' | 'wait' | 'off'
  }): Promise<OutlineToolOutcome> => {
    const { refresh: _refresh, ...outlineInput } = input
    return Promise.resolve(withDatabase(config, (db) => outlineFile(db, outlineInput)))
  },
  codeIndex: ({ mode }: { mode: 'full' | 'incremental' }): Promise<Awaited<ReturnType<typeof indexCodebase>>> =>
    scheduler.submit({ mode }),
})

export const buildMcpDeps = (
  config: CodeindexConfig,
  components: Readonly<McpComponents> = {},
): Parameters<typeof createCodeindexServer>[0] => {
  const scheduler = components.scheduler ?? createReindexScheduler(({ mode }) => indexCodebase({ config, mode }))
  const watcher = components.watcher
  const withDeps = withFreshness(
    buildQueryDeps(config, scheduler),
    config,
    watcher === undefined
      ? (): IndexFreshnessState => neutralFreshnessState
      : (): IndexFreshnessState => watcher.getIndexFreshness(),
  )
  return withRefresh(withDeps, config, {
    submit: (input) => scheduler.submit(input),
    whenSettled: (): Promise<void> => scheduler.whenSettled(),
    getWatcherState: watcher === undefined ? undefined : (): ReturnType<IndexWatcher['getState']> => watcher.getState(),
  })
}

export interface McpRuntime {
  readonly createServer: () => McpServer
  readonly watcher: IndexWatcher
}

export interface CreateMcpRuntimeOptions {
  /** Test seam: replace the reindex runner. Defaults to indexCodebase for config. */
  readonly indexRunner?: (
    input: Readonly<{ mode: 'full' | 'incremental' }>,
  ) => Promise<Awaited<ReturnType<typeof indexCodebase>>>
}

// Shared process-level assembly: one serialized writer (scheduler), one watcher
// feeding freshness state, and a boot-time ensureSchema so queries serve immediately
// even on a fresh worktree. createServer can be called per transport/session; every
// server instance closes over the same deps object.
export const createMcpRuntime = (
  config: CodeindexConfig,
  options: Readonly<CreateMcpRuntimeOptions> = {},
): McpRuntime => {
  const db = openDatabase(config.dbPath)
  try {
    ensureSchema(db)
  } finally {
    db.close()
  }
  const indexRunner =
    options.indexRunner ??
    (({ mode }: Readonly<{ mode: 'full' | 'incremental' }>): Promise<Awaited<ReturnType<typeof indexCodebase>>> =>
      indexCodebase({ config, mode }))
  const scheduler = createReindexScheduler(indexRunner)
  const watcher = createWatcher(config, (input) => scheduler.submit(input))
  const deps = withQueryLogging(buildMcpDeps(config, { scheduler, watcher }), config)
  return {
    createServer: (): McpServer => createCodeindexServer(deps),
    watcher,
  }
}

export const createMcpSession = (
  config: CodeindexConfig,
): Readonly<{ readonly server: McpServer; readonly watcher: IndexWatcher }> => {
  const { createServer, watcher } = createMcpRuntime(config)
  return { server: createServer(), watcher }
}
