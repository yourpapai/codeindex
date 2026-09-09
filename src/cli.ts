import type { Database } from 'bun:sqlite'
import path from 'node:path'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { loadCodeindexConfig, type CodeindexConfig } from './config.js'
import { indexCodebase } from './indexer/index-codebase.js'
import { withFreshness, type IndexFreshnessState } from './mcp/freshness.js'
import { withQueryLogging } from './mcp/query-logging.js'
import { createReindexScheduler, type ReindexScheduler } from './mcp/reindex-scheduler.js'
import { createCodeindexServer } from './mcp/server.js'
import { createWatcher, type IndexWatcher } from './mcp/watcher.js'
import { findIncomingReferences, findSymbolCandidates, searchSymbols } from './search/index.js'
import { openDatabase } from './storage/db.js'
import { openQueryLog, readQueryLogStats } from './storage/query-log.js'
import type { QueryLogStats } from './storage/query-log.js'
import { ensureSchema } from './storage/schema.js'

// Neutral until the watcher (§4) supplies live catch-up state; the wrapper's
// per-hit marks work identically either way.
const neutralFreshnessState: IndexFreshnessState = { indexFreshness: 'fresh' }

export interface McpComponents {
  readonly scheduler?: ReindexScheduler
  readonly watcher?: IndexWatcher
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
        input: Parameters<typeof findIncomingReferences>[1],
      ): Promise<ReturnType<typeof findIncomingReferences>> =>
        Promise.resolve(withDatabase(config, (db) => findIncomingReferences(db, input))),
      codeIndex: ({ mode }: { mode: 'full' | 'incremental' }): Promise<Awaited<ReturnType<typeof indexCodebase>>> =>
        scheduler.submit({ mode }),
    },
    config,
    watcher === undefined
      ? (): IndexFreshnessState => neutralFreshnessState
      : (): IndexFreshnessState => watcher.getIndexFreshness(),
  )
}

// Server assembly: one serialized writer (scheduler), one watcher feeding freshness
// state, and a boot-time ensureSchema so queries serve immediately even on a fresh
// worktree whose database has not been indexed yet.
export const createMcpSession = (
  config: CodeindexConfig,
): Readonly<{ readonly server: McpServer; readonly watcher: IndexWatcher }> => {
  const db = openDatabase(config.dbPath)
  try {
    ensureSchema(db)
  } finally {
    db.close()
  }
  const scheduler = createReindexScheduler(({ mode }) => indexCodebase({ config, mode }))
  const watcher = createWatcher(config, (input) => scheduler.submit(input))
  const deps = withQueryLogging(buildMcpDeps(config, { scheduler, watcher }), config)
  return { server: createCodeindexServer(deps), watcher }
}

const runMcpCommand = async (config: CodeindexConfig): Promise<void> => {
  const { server, watcher } = createMcpSession(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  void watcher.start()
  console.error('codeindex MCP server listening on stdio')
}

export const resolveRepoRoot = (targetPath?: string): string => {
  if (targetPath !== undefined) return path.resolve(targetPath)
  return process.cwd()
}

export const loadConfigForPath = (targetPath?: string): Promise<CodeindexConfig> => {
  const repoRoot = resolveRepoRoot(targetPath)
  return loadCodeindexConfig({
    configPath: path.join(repoRoot, '.codeindex.json'),
    repoRoot,
  })
}

const withDatabase = <T>(config: CodeindexConfig, callback: (db: Database) => T): T => {
  const db = openDatabase(config.dbPath)
  try {
    return callback(db)
  } finally {
    db.close()
  }
}

const logJson = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2))
}

const runSearchCommand = (config: CodeindexConfig, query: string): void => {
  logJson(withDatabase(config, (db) => searchSymbols(db, { query, limit: 10 })))
}

const runSymbolCommand = (config: CodeindexConfig, query: string): void => {
  logJson(withDatabase(config, (db) => findSymbolCandidates(db, query, 10)))
}

const runImpactCommand = (config: CodeindexConfig, qualifiedName: string): void => {
  logJson(withDatabase(config, (db) => findIncomingReferences(db, { qualifiedName, limit: 20 })))
}

const runStatsCommand = (config: CodeindexConfig): void => {
  logJson(
    withDatabase(config, (db) =>
      db
        .query<{ files: number; symbols: number; symbol_references: number }, []>(
          `SELECT
             (SELECT COUNT(*) FROM files WHERE parse_status = 'indexed') AS files,
             (SELECT COUNT(*) FROM symbols) AS symbols,
             (SELECT COUNT(*) FROM symbol_references) AS symbol_references`,
        )
        .get(),
    ),
  )
}

export const runLogStatsCommand = (config: CodeindexConfig): QueryLogStats => {
  const db = openQueryLog(config.queriesPath)
  try {
    const stats = readQueryLogStats(db)
    logJson(stats)
    return stats
  } finally {
    db.close()
  }
}

const main = async (): Promise<void> => {
  const [, , command = 'index', rawArg] = process.argv
  const positional = command === 'index' || command === 'reindex' ? rawArg : undefined
  const config = await loadConfigForPath(positional)

  switch (command) {
    case 'index':
      logJson(await indexCodebase({ config, mode: 'full' }))
      return
    case 'reindex':
      logJson(await indexCodebase({ config, mode: 'incremental' }))
      return
    case 'search':
      runSearchCommand(config, rawArg ?? '')
      return
    case 'symbol':
      runSymbolCommand(config, rawArg ?? '')
      return
    case 'impact':
      runImpactCommand(config, rawArg ?? '')
      return
    case 'stats':
      runStatsCommand(config)
      return
    case 'log-stats':
      runLogStatsCommand(config)
      return
    case 'mcp':
      await runMcpCommand(config)
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
