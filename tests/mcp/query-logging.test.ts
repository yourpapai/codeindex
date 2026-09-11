import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { CodeindexConfig } from '../../src/config.js'
import { withQueryLogging } from '../../src/mcp/query-logging.js'
import { classifyQueryShape, isZeroOrWeakResult } from '../../src/mcp/query-shape.js'
import { createCodeindexServer } from '../../src/mcp/server.js'
import type { CodeindexToolDeps } from '../../src/mcp/tools.js'
import { readQueryLogStats } from '../../src/storage/query-log.js'
import type { RankedSearchResult } from '../../src/types.js'
import { connectClient, emptyOutlineResult } from './harness.js'

const tempDirs: string[] = []

const fakeResult = (qualifiedName: string): RankedSearchResult => ({
  symbolKey: 'k',
  qualifiedName,
  localName: 'x',
  kind: 'variable_declarator',
  scopeTier: 'exported',
  filePath: 'src/x.ts',
  startLine: 1,
  endLine: 1,
  exportNames: [],
  matchedBy: 'exact_export',
  confidence: 'exact',
  snippet: '',
  rankScore: 1,
})

const stubDeps = (): CodeindexToolDeps => ({
  codeSearch: (): ReturnType<CodeindexToolDeps['codeSearch']> => Promise.resolve([fakeResult('src/x#found')]),
  codeSymbol: (): ReturnType<CodeindexToolDeps['codeSymbol']> => Promise.resolve([]),
  codeImpact: (): ReturnType<CodeindexToolDeps['codeImpact']> =>
    Promise.resolve({ resolution: { status: 'unresolved' as const }, results: [] }),
  codeOutline: (input): ReturnType<CodeindexToolDeps['codeOutline']> => Promise.resolve(emptyOutlineResult(input)),
  codeIndex: (): ReturnType<CodeindexToolDeps['codeIndex']> =>
    Promise.resolve({
      filesIndexed: 0,
      filesFailed: 0,
      filesPruned: 0,
      skippedFiles: [],
      skippedFilesTotal: 0,
      symbolsIndexed: 0,
      referencesIndexed: 0,
      referencesUnresolved: 0,
      referencesRepaired: 0,
      elapsedMs: 0,
    }),
})

const configWith = (logQueries: boolean): CodeindexConfig => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-qlog-'))
  tempDirs.push(dir)
  return {
    roots: ['src'],
    exclude: [],
    languages: ['ts'],
    dbPath: path.join(dir, 'index.db'),
    queriesPath: path.join(dir, 'queries.db'),
    logQueries,
    indexLocals: true,
    indexVariables: true,
    includeDocComments: true,
    maxStoredBodyLines: 120,
    maxFileSizeBytes: 1_000_000,
    tsconfigPaths: [path.join(dir, 'tsconfig.json')],
    repoRoot: dir,
    configPath: path.join(dir, '.codeindex.json'),
  }
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

interface LatestQueryRow {
  readonly query_text: string | null
  readonly query_shape: string | null
  readonly zero_or_weak: number | null
  readonly mode: string | null
  readonly matched_by: string | null
  readonly result_count: number
}

const readLatestRow = (queriesPath: string): LatestQueryRow => {
  const db = new Database(queriesPath)
  try {
    return db
      .query<LatestQueryRow, []>(
        `SELECT query_text, query_shape, zero_or_weak, mode, matched_by, result_count
         FROM query_log ORDER BY id DESC LIMIT 1`,
      )
      .get()!
  } finally {
    db.close()
  }
}

describe('classifyQueryShape', () => {
  test('empty and blank queries are empty', () => {
    expect(classifyQueryShape(null)).toBe('empty')
    expect(classifyQueryShape(undefined)).toBe('empty')
    expect(classifyQueryShape('')).toBe('empty')
    expect(classifyQueryShape('   ')).toBe('empty')
  })

  test('identifier-shaped queries are identifiers', () => {
    expect(classifyQueryShape('openDatabase')).toBe('identifier')
    expect(classifyQueryShape('src/storage/db#openDatabase')).toBe('identifier')
    expect(classifyQueryShape('parent>name')).toBe('identifier')
    expect(classifyQueryShape('searchSymbols')).toBe('identifier')
  })

  test('multi-token lexical queries stay lexical, not identifier', () => {
    expect(classifyQueryShape('index command')).toBe('multi_token_lexical')
    expect(classifyQueryShape('query log')).toBe('multi_token_lexical')
  })

  test('natural-language-ish multi-word queries are nl', () => {
    expect(classifyQueryShape('rerank search results relevance')).toBe('nl')
    expect(classifyQueryShape('index command CLI')).toBe('nl')
    expect(classifyQueryShape('how do I find who calls a function')).toBe('nl')
  })
})

describe('isZeroOrWeakResult', () => {
  test('zero results are always weak', () => {
    expect(isZeroOrWeakResult(0, 10)).toBe(true)
    expect(isZeroOrWeakResult(0, undefined)).toBe(true)
  })

  test('a full page matching the requested limit is not weak', () => {
    expect(isZeroOrWeakResult(10, 10)).toBe(false)
    expect(isZeroOrWeakResult(5, 5)).toBe(false)
  })

  test('fewer results than the requested limit is weak', () => {
    expect(isZeroOrWeakResult(3, 10)).toBe(true)
  })

  test('without a limit, the absolute floor is three', () => {
    expect(isZeroOrWeakResult(2, undefined)).toBe(true)
    expect(isZeroOrWeakResult(3, undefined)).toBe(false)
    expect(isZeroOrWeakResult(7, undefined)).toBe(false)
  })
})

describe('withQueryLogging', () => {
  test('logs a code_search call to the queries db', async () => {
    const config = configWith(true)
    const wrapped = withQueryLogging(stubDeps(), config)
    const results = await wrapped.codeSearch({ query: 'find me', limit: 10 })
    expect(results.length).toBe(1)
    const db = new Database(config.queriesPath)
    try {
      const stats = readQueryLogStats(db)
      expect(stats.total).toBe(1)
      expect(stats.hits).toBe(1)
      expect(stats.topQueries[0]!.queryText).toBe('find me')
    } finally {
      db.close()
    }
  })

  test('logs query_shape, zero_or_weak, mode, and matched_by ride-along fields', async () => {
    const config = configWith(true)
    const wrapped = withQueryLogging(stubDeps(), config)
    await wrapped.codeSearch({ query: 'openDatabase', limit: 10, mode: 'exact' })
    const row = readLatestRow(config.queriesPath)
    expect(row.query_text).toBe('openDatabase')
    expect(row.query_shape).toBe('identifier')
    expect(row.zero_or_weak).toBe(1)
    expect(row.mode).toBe('exact')
    expect(row.matched_by).toBe('exact_export')
  })

  test('does not invent a mode when the caller omitted it', async () => {
    const config = configWith(true)
    const wrapped = withQueryLogging(stubDeps(), config)
    await wrapped.codeSearch({ query: 'openDatabase', limit: 10 })
    const row = readLatestRow(config.queriesPath)
    expect(row.mode).toBeNull()
    expect(row.matched_by).toBe('exact_export')
  })

  test('does not log when logQueries is false', async () => {
    const config = configWith(false)
    const wrapped = withQueryLogging(stubDeps(), config)
    await wrapped.codeSearch({ query: 'nope', limit: 10 })
    // queries.db is never created when logging is off; opening it fresh yields an empty schema-less db.
    const db = new Database(config.queriesPath)
    try {
      const table = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='query_log'")
        .get()
      expect(table).toBeNull()
    } finally {
      db.close()
    }
  })

  test('returns the real result even if logging cannot write', async () => {
    const config = configWith(true)
    // Point queriesPath at an unwritable location to force a logging failure.
    const brokenConfig: CodeindexConfig = { ...config, queriesPath: path.join(config.repoRoot, 'no-such-dir', 'q.db') }
    const wrapped = withQueryLogging(stubDeps(), brokenConfig)
    const originalError = console.error
    console.error = (): void => {}
    try {
      const results = await wrapped.codeSearch({ query: 'x', limit: 10 })
      expect(results.length).toBe(1)
    } finally {
      console.error = originalError
    }
  })

  test('reports a recording failure to stderr while the query succeeds', async () => {
    const config = configWith(true)
    const notADb = path.join(config.repoRoot, 'not-a-db')
    writeFileSync(notADb, 'this is definitely not a sqlite database')
    const brokenConfig: CodeindexConfig = { ...config, queriesPath: notADb }
    const wrapped = withQueryLogging(stubDeps(), brokenConfig)
    const originalError = console.error
    const reported: string[] = []
    console.error = (message?: unknown): void => {
      reported.push(String(message))
    }
    try {
      const results = await wrapped.codeSearch({ query: 'x', limit: 10 })
      expect(results.length).toBe(1)
    } finally {
      console.error = originalError
    }
    expect(reported.length).toBe(1)
    expect(reported[0]).toContain('code_search')
    expect(reported[0]).toContain('file is not a database')
  })

  test('logs an error row and rethrows when the wrapped tool rejects', async () => {
    const config = configWith(true)
    const failingDeps: CodeindexToolDeps = {
      ...stubDeps(),
      codeSearch: (): ReturnType<CodeindexToolDeps['codeSearch']> => Promise.reject(new Error('boom')),
    }
    const wrapped = withQueryLogging(failingDeps, config)
    await expect(wrapped.codeSearch({ query: 'x', limit: 10 })).rejects.toThrow('boom')
    const db = new Database(config.queriesPath)
    try {
      const stats = readQueryLogStats(db)
      expect(stats.total).toBe(1)
      const row = db.query<{ error: string | null }, []>('SELECT error FROM query_log').get()
      expect(row).not.toBeNull()
      expect(row!.error).toBe('boom')
    } finally {
      db.close()
    }
  })

  test('logs code_outline with filePath as query_text and mode symbols|exports', async () => {
    const config = configWith(true)
    const wrapped = withQueryLogging(stubDeps(), config)
    await wrapped.codeOutline({ filePath: 'src/foo.ts', mode: 'symbols', limit: 200 })
    let row = readLatestRow(config.queriesPath)
    expect(row.query_text).toBe('src/foo.ts')
    expect(row.query_shape).toBe('identifier')
    expect(row.mode).toBe('symbols')

    await wrapped.codeOutline({ filePath: 'src/index.ts', mode: 'exports', limit: 200 })
    row = readLatestRow(config.queriesPath)
    expect(row.query_text).toBe('src/index.ts')
    expect(row.mode).toBe('exports')
  })
})

describe('withQueryLogging through the protocol', () => {
  test('a callTool round-trip produces a log row', async () => {
    const config = configWith(true)
    const server = createCodeindexServer(withQueryLogging(stubDeps(), config))
    const client = await connectClient(server)
    await client.callTool({ name: 'code_search', arguments: { query: 'via protocol' } })
    const db = new Database(config.queriesPath)
    try {
      expect(readQueryLogStats(db).total).toBe(1)
    } finally {
      db.close()
    }
  })
})
