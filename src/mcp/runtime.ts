import type { Database } from 'bun:sqlite'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { CodeindexConfig } from '../config.js'
import { indexCodebase } from '../indexer/index-codebase.js'
import { findSymbolCandidates, resolveIncomingReferences, searchSymbols } from '../search/index.js'
import { openDatabase } from '../storage/db.js'
import { ensureSchema } from '../storage/schema.js'
import { withFreshness, type IndexFreshnessState } from './freshness.js'
import { withQueryLogging } from './query-logging.js'
import { createReindexScheduler, type ReindexScheduler } from './reindex-scheduler.js'
import { createCodeindexServer } from './server.js'
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

export const buildMcpDeps = (
  config: CodeindexConfig,
  components: Readonly<McpComponents> = {},
): Parameters<typeof createCodeindexServer>[0] => {
  const scheduler = components.scheduler ?? createReindexScheduler(({ mode }) => indexCodebase({ config, mode }))
  const watcher = components.watcher
  return withFreshness(
    {
      codeSearch: (input: Parameters<typeof searchSymbols>[1]): Promise<ReturnType<typeof searchSymbols>> =>
        Promise.resolve(withDatabase(config, (db) => searchSymbols(db, input))),
      codeSymbol: (query: string, limit: number): Promise<ReturnType<typeof findSymbolCandidates>> =>
        Promise.resolve(withDatabase(config, (db) => findSymbolCandidates(db, query, limit))),
      codeImpact: (
        input: Parameters<typeof resolveIncomingReferences>[1],
      ): Promise<ReturnType<typeof resolveIncomingReferences>> =>
        Promise.resolve(withDatabase(config, (db) => resolveIncomingReferences(db, input))),
      codeIndex: ({ mode }: { mode: 'full' | 'incremental' }): Promise<Awaited<ReturnType<typeof indexCodebase>>> =>
        scheduler.submit({ mode }),
    },
    config,
    watcher === undefined
      ? (): IndexFreshnessState => neutralFreshnessState
      : (): IndexFreshnessState => watcher.getIndexFreshness(),
  )
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
