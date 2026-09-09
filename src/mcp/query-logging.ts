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
  readonly error: string | null
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
    error: input.error,
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

interface RecordBase {
  readonly tool: string
  readonly queryText: string | null
  readonly filtersJson: string | null
}

interface ResultFields {
  readonly resultCount: number
  readonly topQualifiedNames: readonly string[]
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const runLogged = async <T>(
  queriesPath: string,
  base: Readonly<RecordBase>,
  attempt: () => Promise<T>,
  toResultFields: (result: T) => ResultFields,
): Promise<T> => {
  const started = Date.now()
  try {
    const result = await attempt()
    record(queriesPath, { ...base, ...toResultFields(result), latencyMs: Date.now() - started, error: null })
    return result
  } catch (err) {
    record(queriesPath, {
      ...base,
      resultCount: 0,
      topQualifiedNames: [],
      latencyMs: Date.now() - started,
      error: errorMessage(err),
    })
    throw err
  }
}

const wrapCodeSearch = (deps: Readonly<CodeindexToolDeps>, queriesPath: string): CodeindexToolDeps['codeSearch'] => {
  return (
    input: Parameters<CodeindexToolDeps['codeSearch']>[0],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeSearch']>>> => {
    return runLogged(
      queriesPath,
      {
        tool: 'code_search',
        queryText: input.query,
        filtersJson: JSON.stringify({
          kinds: input.kinds,
          scopeTiers: input.scopeTiers,
          pathPrefix: input.pathPrefix,
          limit: input.limit,
        }),
      },
      () => deps.codeSearch(input),
      (results) => ({ resultCount: results.length, topQualifiedNames: topNames(results, 3) }),
    )
  }
}

const wrapCodeSymbol = (deps: Readonly<CodeindexToolDeps>, queriesPath: string): CodeindexToolDeps['codeSymbol'] => {
  return (
    query: Parameters<CodeindexToolDeps['codeSymbol']>[0],
    limit: Parameters<CodeindexToolDeps['codeSymbol']>[1],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeSymbol']>>> => {
    return runLogged(
      queriesPath,
      { tool: 'code_symbol', queryText: query, filtersJson: JSON.stringify({ limit }) },
      () => deps.codeSymbol(query, limit),
      (results) => ({ resultCount: results.length, topQualifiedNames: topNames(results, 3) }),
    )
  }
}

const wrapCodeImpact = (deps: Readonly<CodeindexToolDeps>, queriesPath: string): CodeindexToolDeps['codeImpact'] => {
  return (
    input: Parameters<CodeindexToolDeps['codeImpact']>[0],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeImpact']>>> => {
    return runLogged(
      queriesPath,
      {
        tool: 'code_impact',
        queryText: input.qualifiedName ?? input.symbolKey ?? null,
        filtersJson: JSON.stringify({ limit: input.limit }),
      },
      () => deps.codeImpact(input),
      (results) => ({
        resultCount: results.length,
        topQualifiedNames: results
          .map((row) => row.sourceQualifiedName)
          .filter((name): name is string => name !== null)
          .slice(0, 3),
      }),
    )
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
    getIndexFreshness: deps.getIndexFreshness,
  }
}
