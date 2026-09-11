import type { Database } from 'bun:sqlite'
import path from 'node:path'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { loadCodeindexConfig, type CodeindexConfig } from './config.js'
import { indexCodebase } from './indexer/index-codebase.js'
import {
  buildMcpDeps,
  createMcpRuntime,
  createMcpSession,
  type CreateMcpRuntimeOptions,
  type McpComponents,
  type McpRuntime,
} from './mcp/runtime.js'
import { loadServeToken, parseServeArgs, runServeCommand } from './mcp/serve.js'
import { findIncomingReferences, findSymbolCandidates, searchSymbols } from './search/index.js'
import { openDatabase } from './storage/db.js'
import { openQueryLog, readQueryLogStats } from './storage/query-log.js'
import type { QueryLogStats } from './storage/query-log.js'

export {
  buildMcpDeps,
  createMcpRuntime,
  createMcpSession,
  type CreateMcpRuntimeOptions,
  type McpComponents,
  type McpRuntime,
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

const runServeCli = async (rest: readonly string[]): Promise<void> => {
  const { port, path: servePath } = parseServeArgs(rest)
  const serveConfig = await loadConfigForPath(servePath)
  await runServeCommand(serveConfig, { port, token: loadServeToken() })
}

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const command = argv[0] ?? 'index'
  const rest = argv.slice(1)

  if (command === 'serve') {
    await runServeCli(rest)
    return
  }

  const rawArg = rest[0]
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
