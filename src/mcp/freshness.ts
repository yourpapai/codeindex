import type { Database } from 'bun:sqlite'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import type { CodeindexConfig } from '../config.js'
import { sha256 } from '../indexer/resolve-files.js'
import { openDatabase } from '../storage/db.js'
import type { CodeindexToolDeps, Freshness, FreshnessMark } from './tools.js'

export interface IndexFreshnessState {
  readonly indexFreshness: Freshness
}

export type IndexFreshnessStateProvider = () => IndexFreshnessState

export type FreshnessContext = Readonly<Pick<CodeindexConfig, 'repoRoot' | 'dbPath'>>

interface FileFreshnessRow {
  readonly file_path: string
  readonly indexed_at: number
  readonly file_hash: string
}

const loadFileRows = (db: Database, filePaths: readonly string[]): ReadonlyMap<string, FileFreshnessRow> => {
  if (filePaths.length === 0) {
    return new Map()
  }
  const placeholders = filePaths.map(() => '?').join(', ')
  const rows = db
    .query<FileFreshnessRow, string[]>(
      `SELECT file_path, indexed_at, file_hash FROM files WHERE file_path IN (${placeholders})`,
    )
    .all(...filePaths)
  return new Map(rows.map((row) => [row.file_path, row]))
}

const loadFileRowsOrEmpty = (db: Database, filePaths: readonly string[]): ReadonlyMap<string, FileFreshnessRow> => {
  // A missing or unreadable files table (fresh DB before the first index) is missing evidence —
  // the conservative contract marks every hit possibly_stale rather than failing the query.
  try {
    return loadFileRows(db, filePaths)
  } catch {
    return new Map()
  }
}

const determineFreshness = async (
  absolutePath: string,
  row: FileFreshnessRow | undefined,
  mtimeMs: number,
): Promise<Freshness> => {
  if (row === undefined) {
    return 'possibly_stale'
  }
  if (row.indexed_at >= mtimeMs) {
    return 'fresh'
  }
  try {
    return sha256(await readFile(absolutePath, 'utf8')) === row.file_hash ? 'fresh' : 'possibly_stale'
  } catch {
    return 'possibly_stale'
  }
}

const decorateWithFreshness = async <T>(
  results: readonly T[],
  getFilePath: (result: T) => string,
  context: FreshnessContext,
): Promise<readonly (T & FreshnessMark)[]> => {
  if (results.length === 0) {
    return results.map((result) => ({ ...result, freshness: undefined }))
  }
  const filePaths = [...new Set(results.map(getFilePath))]
  const db = openDatabase(context.dbPath)
  try {
    const rows = loadFileRowsOrEmpty(db, filePaths)
    return await Promise.all(
      results.map(async (result) => {
        const filePath = getFilePath(result)
        const absolutePath = path.resolve(context.repoRoot, filePath)
        let mtimeMs: number
        try {
          mtimeMs = (await stat(absolutePath)).mtimeMs
        } catch {
          return { ...result, freshness: 'possibly_stale' as const }
        }
        return { ...result, freshness: await determineFreshness(absolutePath, rows.get(filePath), mtimeMs) }
      }),
    )
  } finally {
    db.close()
  }
}

export const withFreshness = (
  deps: Readonly<Omit<CodeindexToolDeps, 'getIndexFreshness'>>,
  config: FreshnessContext,
  stateProvider: IndexFreshnessStateProvider,
): CodeindexToolDeps => ({
  codeSearch: async (
    input: Parameters<CodeindexToolDeps['codeSearch']>[0],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeSearch']>>> =>
    decorateWithFreshness(await deps.codeSearch(input), (row) => row.filePath, config),
  codeSymbol: async (
    query: Parameters<CodeindexToolDeps['codeSymbol']>[0],
    limit: Parameters<CodeindexToolDeps['codeSymbol']>[1],
    refresh: Parameters<CodeindexToolDeps['codeSymbol']>[2],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeSymbol']>>> =>
    decorateWithFreshness(await deps.codeSymbol(query, limit, refresh), (row) => row.filePath, config),
  codeImpact: async (
    input: Parameters<CodeindexToolDeps['codeImpact']>[0],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeImpact']>>> => {
    const outcome = await deps.codeImpact(input)
    return {
      resolution: outcome.resolution,
      results: await decorateWithFreshness(outcome.results, (row) => row.sourceFilePath, config),
    }
  },
  codeOutline: async (
    input: Parameters<CodeindexToolDeps['codeOutline']>[0],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeOutline']>>> => {
    const outcome = await deps.codeOutline(input)
    if (outcome.mode === 'symbols') {
      return {
        ...outcome,
        results: await decorateWithFreshness(outcome.results, (row) => row.filePath, config),
      }
    }
    return {
      ...outcome,
      results: await decorateWithFreshness(outcome.results, (row) => row.filePath, config),
    }
  },
  codeIndex: (
    input: Parameters<CodeindexToolDeps['codeIndex']>[0],
  ): Promise<Awaited<ReturnType<CodeindexToolDeps['codeIndex']>>> => deps.codeIndex(input),
  getIndexFreshness: (): Freshness => stateProvider().indexFreshness,
  getWatcherState: deps.getWatcherState,
  logResponseBytes: deps.logResponseBytes,
})
