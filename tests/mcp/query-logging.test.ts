import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { CodeindexConfig } from '../../src/config.js'
import { withQueryLogging } from '../../src/mcp/query-logging.js'
import { createCodeindexServer } from '../../src/mcp/server.js'
import type { CodeindexToolDeps } from '../../src/mcp/tools.js'
import { readQueryLogStats } from '../../src/storage/query-log.js'
import type { RankedSearchResult } from '../../src/types.js'
import { connectClient } from './harness.js'

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
  matchReason: 'exact',
  confidence: 'exact',
  snippet: '',
  rankScore: 1,
})

const stubDeps = (): CodeindexToolDeps => ({
  codeSearch: (): ReturnType<CodeindexToolDeps['codeSearch']> => Promise.resolve([fakeResult('src/x#found')]),
  codeSymbol: (): ReturnType<CodeindexToolDeps['codeSymbol']> => Promise.resolve([]),
  codeImpact: (): ReturnType<CodeindexToolDeps['codeImpact']> => Promise.resolve([]),
  codeIndex: (): ReturnType<CodeindexToolDeps['codeIndex']> =>
    Promise.resolve({
      filesIndexed: 0,
      filesFailed: 0,
      filesPruned: 0,
      skippedFiles: [],
      symbolsIndexed: 0,
      referencesIndexed: 0,
      referencesUnresolved: 0,
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
    const results = await wrapped.codeSearch({ query: 'x', limit: 10 })
    expect(results.length).toBe(1)
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
