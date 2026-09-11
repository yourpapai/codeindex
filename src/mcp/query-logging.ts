import type { CodeindexConfig } from '../config.js'
import { insertQueryLogEntry, openQueryLog, updateLatestResponseBytes } from '../storage/query-log.js'
import type { QueryLogEntry } from '../storage/query-log.js'
import { classifyQueryShape, isZeroOrWeakResult } from './query-shape.js'
import type { CodeindexToolDeps } from './tools.js'

interface RecordInput {
  readonly tool: string
  readonly queryText: string | null
  readonly filtersJson: string | null
  readonly resultCount: number
  readonly latencyMs: number
  readonly topQualifiedNames: readonly string[]
  readonly error: string | null
  readonly limit?: number | null
  readonly mode?: string | null
  readonly matchedBy?: string | null
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
    queryShape: classifyQueryShape(input.queryText),
    zeroOrWeak: isZeroOrWeakResult(input.resultCount, input.limit),
    mode: input.mode ?? null,
    matchedBy: input.matchedBy ?? null,
  }
  try {
    const db = openQueryLog(queriesPath)
    try {
      insertQueryLogEntry(db, entry)
    } finally {
      db.close()
    }
  } catch (err) {
    // Query logging is best-effort observability; never let it fail a real query.
    console.error(`[codeindex] query-log record failed for ${input.tool}: ${errorMessage(err)}`)
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
  base: Readonly<RecordBase & { limit?: number | null; mode?: string | null }>,
  attempt: () => Promise<T>,
  toResultFields: (result: T) => ResultFields & { matchedBy?: string | null; limit?: number | null },
): Promise<T> => {
  const started = Date.now()
  try {
    const result = await attempt()
    const fields = toResultFields(result)
    record(queriesPath, {
      ...base,
      resultCount: fields.resultCount,
      topQualifiedNames: fields.topQualifiedNames,
      latencyMs: Date.now() - started,
      error: null,
      limit: fields.limit ?? base.limit ?? null,
      mode: base.mode ?? null,
      matchedBy: fields.matchedBy ?? null,
    })
    return result
  } catch (err) {
    record(queriesPath, {
      ...base,
      resultCount: 0,
      topQualifiedNames: [],
      latencyMs: Date.now() - started,
      error: errorMessage(err),
      limit: base.limit ?? null,
      mode: base.mode ?? null,
      matchedBy: null,
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
        limit: input.limit,
        mode: input.mode ?? null,
      },
      () => deps.codeSearch(input),
      (results) => ({
        resultCount: results.length,
        topQualifiedNames: topNames(results, 3),
        matchedBy: results[0]?.matchedBy ?? null,
        limit: input.limit,
      }),
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
      { tool: 'code_symbol', queryText: query, filtersJson: JSON.stringify({ limit }), limit },
      () => deps.codeSymbol(query, limit),
      (results) => ({
        resultCount: results.length,
        topQualifiedNames: topNames(results, 3),
        matchedBy: results[0]?.matchedBy ?? null,
        limit,
      }),
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
        limit: input.limit,
      },
      () => deps.codeImpact(input),
      (outcome) => ({
        resultCount: outcome.results.length,
        topQualifiedNames: outcome.results
          .map((row) => row.sourceQualifiedName)
          .filter((name): name is string => name !== null)
          .slice(0, 3),
        matchedBy: outcome.resolution.status === 'unresolved' ? null : (outcome.resolution.matchedBy ?? null),
        limit: input.limit,
      }),
    )
  }
}

const wrapCodeOutline = (deps: Readonly<CodeindexToolDeps>, queriesPath: string): CodeindexToolDeps['codeOutline'] => {
  return (
    input: Parameters<CodeindexToolDeps['codeOutline']>[0],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeOutline']>>> => {
    return runLogged(
      queriesPath,
      {
        tool: 'code_outline',
        queryText: input.filePath,
        filtersJson: JSON.stringify({
          filePath: input.filePath,
          scopeTiers: input.scopeTiers,
          kinds: input.kinds,
          limit: input.limit,
        }),
        limit: input.limit,
        mode: input.mode,
      },
      () => deps.codeOutline(input),
      (outcome) => ({
        resultCount: outcome.resultCount,
        topQualifiedNames:
          outcome.mode === 'symbols'
            ? topNames(outcome.results, 3)
            : outcome.results.map((row) => row.exportName).slice(0, 3),
        matchedBy: null,
        limit: input.limit,
      }),
    )
  }
}

export const withQueryLogging = (deps: Readonly<CodeindexToolDeps>, config: CodeindexConfig): CodeindexToolDeps => {
  if (!config.logQueries) {
    return deps
  }
  const queriesPath = config.queriesPath
  const logResponseBytes = (tool: string, bytes: number): void => {
    try {
      const db = openQueryLog(queriesPath)
      try {
        updateLatestResponseBytes(db, tool, bytes)
      } finally {
        db.close()
      }
    } catch (err) {
      console.error(`[codeindex] query-log response_bytes update failed for ${tool}: ${errorMessage(err)}`)
    }
  }
  return {
    codeSearch: wrapCodeSearch(deps, queriesPath),
    codeSymbol: wrapCodeSymbol(deps, queriesPath),
    codeImpact: wrapCodeImpact(deps, queriesPath),
    codeOutline: wrapCodeOutline(deps, queriesPath),
    codeIndex: deps.codeIndex,
    getIndexFreshness: deps.getIndexFreshness,
    getWatcherState: deps.getWatcherState,
    logResponseBytes,
  }
}
