import type { CodeindexConfig } from '../config.js'
import { insertQueryLogEntry, openQueryLog } from '../storage/query-log.js'
import type { QueryLogEntry } from '../storage/query-log.js'
import type { CodeindexToolDeps } from './tools.js'

interface RecordInput {
  readonly tool: string
  readonly queryText: string | null
  readonly filtersJson: string | null
  readonly resultCount: number
  readonly latencyMs: number
  readonly topQualifiedNames: readonly string[]
}

const record = (queriesPath: string, input: RecordInput): void => {
  const entry: QueryLogEntry = {
    timestamp: new Date().toISOString(),
    tool: input.tool,
    queryText: input.queryText,
    filtersJson: input.filtersJson,
    resultCount: input.resultCount,
    hit: input.resultCount > 0,
    latencyMs: input.latencyMs,
    topQualifiedNames: input.topQualifiedNames,
  }
  try {
    const db = openQueryLog(queriesPath)
    try {
      insertQueryLogEntry(db, entry)
    } finally {
      db.close()
    }
  } catch {
    // Query logging is best-effort observability; never let it fail a real query.
  }
}

const topNames = (rows: readonly { readonly qualifiedName: string }[], count: number): readonly string[] =>
  rows.slice(0, count).map((row) => row.qualifiedName)

const wrapCodeSearch = (deps: Readonly<CodeindexToolDeps>, queriesPath: string): CodeindexToolDeps['codeSearch'] => {
  return async (
    input: Parameters<CodeindexToolDeps['codeSearch']>[0],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeSearch']>>> => {
    const started = Date.now()
    const results = await deps.codeSearch(input)
    record(queriesPath, {
      tool: 'code_search',
      queryText: input.query,
      filtersJson: JSON.stringify({
        kinds: input.kinds,
        scopeTiers: input.scopeTiers,
        pathPrefix: input.pathPrefix,
        limit: input.limit,
      }),
      resultCount: results.length,
      latencyMs: Date.now() - started,
      topQualifiedNames: topNames(results, 3),
    })
    return results
  }
}

const wrapCodeSymbol = (deps: Readonly<CodeindexToolDeps>, queriesPath: string): CodeindexToolDeps['codeSymbol'] => {
  return async (
    query: Parameters<CodeindexToolDeps['codeSymbol']>[0],
    limit: Parameters<CodeindexToolDeps['codeSymbol']>[1],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeSymbol']>>> => {
    const started = Date.now()
    const results = await deps.codeSymbol(query, limit)
    record(queriesPath, {
      tool: 'code_symbol',
      queryText: query,
      filtersJson: JSON.stringify({ limit }),
      resultCount: results.length,
      latencyMs: Date.now() - started,
      topQualifiedNames: topNames(results, 3),
    })
    return results
  }
}

const wrapCodeImpact = (deps: Readonly<CodeindexToolDeps>, queriesPath: string): CodeindexToolDeps['codeImpact'] => {
  return async (
    input: Parameters<CodeindexToolDeps['codeImpact']>[0],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeImpact']>>> => {
    const started = Date.now()
    const results = await deps.codeImpact(input)
    const sourceNames = results.map((row) => row.sourceQualifiedName).filter((name): name is string => name !== null)
    record(queriesPath, {
      tool: 'code_impact',
      queryText: input.qualifiedName ?? input.symbolKey ?? null,
      filtersJson: JSON.stringify({ limit: input.limit }),
      resultCount: results.length,
      latencyMs: Date.now() - started,
      topQualifiedNames: sourceNames.slice(0, 3),
    })
    return results
  }
}

export const withQueryLogging = (deps: Readonly<CodeindexToolDeps>, config: CodeindexConfig): CodeindexToolDeps => {
  if (!config.logQueries) {
    return deps
  }
  const queriesPath = config.queriesPath
  return {
    codeSearch: wrapCodeSearch(deps, queriesPath),
    codeSymbol: wrapCodeSymbol(deps, queriesPath),
    codeImpact: wrapCodeImpact(deps, queriesPath),
    codeIndex: deps.codeIndex,
  }
}
