import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { TextContent } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { CodeindexConfig } from '../../src/config.js'
import { withQueryLogging } from '../../src/mcp/query-logging.js'
import { createCodeindexServer } from '../../src/mcp/server.js'
import { buildStructuredToolResult, type CodeindexToolDeps, CodeSearchOutputSchema } from '../../src/mcp/tools.js'
import { ensureQueryLogSchema, insertQueryLogEntry, openQueryLog } from '../../src/storage/query-log.js'
import type { QueryLogEntry } from '../../src/storage/query-log.js'
import type { RankedSearchResult } from '../../src/types.js'
import { connectClient } from './harness.js'

const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

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
  snippet: 'export const x = 1',
  rankScore: 1,
})

const stubDeps = (): CodeindexToolDeps => ({
  codeSearch: (): ReturnType<CodeindexToolDeps['codeSearch']> =>
    Promise.resolve([fakeResult('src/x#found'), fakeResult('src/y#other')]),
  codeSymbol: (): ReturnType<CodeindexToolDeps['codeSymbol']> => Promise.resolve([fakeResult('src/x#found')]),
  codeImpact: (): ReturnType<CodeindexToolDeps['codeImpact']> =>
    Promise.resolve({ resolution: { status: 'unresolved' as const }, results: [] }),
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
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-resp-bytes-'))
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

const readLatestResponseBytes = (queriesPath: string): number | null => {
  const db = new Database(queriesPath)
  try {
    const row = db
      .query<{ response_bytes: number | null }, []>('SELECT response_bytes FROM query_log ORDER BY id DESC LIMIT 1')
      .get()
    return row === null ? null : row.response_bytes
  } finally {
    db.close()
  }
}

describe('response_bytes is recorded for successful tool calls', () => {
  test('successful code_search logs response_bytes equal to text+structured UTF-8 size', async () => {
    const config = configWith(true)
    const wrapped = withQueryLogging(stubDeps(), config)
    const server = createCodeindexServer(wrapped)
    const client = await connectClient(server)

    const result = await client.callTool({ name: 'code_search', arguments: { query: 'found' } })
    expect(result.isError).not.toBe(true)

    const parsed = CallToolResultSchema.parse(result)
    const structured = CodeSearchOutputSchema.parse(parsed.structuredContent)
    const text = parsed.content
      .filter((entry): entry is TextContent => entry.type === 'text')
      .map((entry) => entry.text)
      .join('\n')
    const expected = Buffer.byteLength(text, 'utf8') + Buffer.byteLength(JSON.stringify(structured), 'utf8')

    const logged = readLatestResponseBytes(config.queriesPath)
    expect(logged).not.toBeNull()
    expect(logged!).toBeGreaterThan(0)
    expect(logged).toBe(expected)
  })

  test('successful code_symbol and code_impact also record response_bytes', async () => {
    const config = configWith(true)
    const deps: CodeindexToolDeps = {
      ...stubDeps(),
      codeImpact: (): ReturnType<CodeindexToolDeps['codeImpact']> =>
        Promise.resolve({
          resolution: {
            status: 'canonical' as const,
            matchedBy: 'qualified_name' as const,
            symbolKey: 'src/a.ts#1',
            qualifiedName: 'src/x#found',
          },
          results: [
            {
              sourceQualifiedName: 'src/a#caller',
              sourceFilePath: 'src/a.ts',
              edgeType: 'calls',
              confidence: 'resolved',
              lineNumber: 3,
            },
          ],
        }),
    }
    const client = await connectClient(createCodeindexServer(withQueryLogging(deps, config)))

    await client.callTool({ name: 'code_symbol', arguments: { query: 'found' } })
    expect(readLatestResponseBytes(config.queriesPath)).toBeGreaterThan(0)

    await client.callTool({ name: 'code_impact', arguments: { qualifiedName: 'src/x#found' } })
    expect(readLatestResponseBytes(config.queriesPath)).toBeGreaterThan(0)
  })

  test('logging failure does not fail the tool call', async () => {
    const config = configWith(true)
    const broken: CodeindexConfig = {
      ...config,
      queriesPath: path.join(config.repoRoot, 'no-such-dir', 'q.db'),
    }
    const client = await connectClient(createCodeindexServer(withQueryLogging(stubDeps(), broken)))
    const originalError = console.error
    console.error = (): void => {}
    try {
      const result = await client.callTool({ name: 'code_search', arguments: { query: 'found' } })
      expect(result.isError).not.toBe(true)
      const payload = CodeSearchOutputSchema.parse(result.structuredContent)
      expect(payload.resultCount).toBeGreaterThan(0)
    } finally {
      console.error = originalError
    }
  })
})

describe('query_log schema migration preserves history', () => {
  const baseEntry = (overrides: Partial<QueryLogEntry> = {}): QueryLogEntry => ({
    timestamp: '2026-07-21T00:00:00.000Z',
    tool: 'code_search',
    queryText: 'legacy',
    filtersJson: JSON.stringify({ limit: 10 }),
    resultCount: 1,
    hit: true,
    latencyMs: 2,
    topQualifiedNames: ['src/x#found'],
    error: null,
    responseBytes: undefined,
    ...overrides,
  })

  test('pre-upgrade queries.db rows keep NULL response_bytes after open', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-legacy-bytes-'))
    tempDirs.push(dir)
    const queriesPath = path.join(dir, 'queries.db')

    // Build a v1-era DB: same table as today, but user_version 1 and no response_bytes column.
    const legacy = new Database(queriesPath)
    try {
      legacy.run(`CREATE TABLE query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        tool TEXT NOT NULL,
        query_text TEXT,
        filters_json TEXT,
        result_count INTEGER NOT NULL,
        hit INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        top_qualified_names TEXT NOT NULL,
        error TEXT
      )`)
      legacy.run(
        `INSERT INTO query_log (timestamp, tool, query_text, filters_json, result_count, hit, latency_ms, top_qualified_names, error)
         VALUES ('2026-01-01T00:00:00.000Z', 'code_search', 'old', NULL, 1, 1, 4, '["src/x#found"]', NULL)`,
      )
      legacy.run('PRAGMA user_version = 1')
    } finally {
      legacy.close()
    }

    const db = openQueryLog(queriesPath)
    try {
      const legacyRow = db
        .query<{ response_bytes: number | null }, [string]>('SELECT response_bytes FROM query_log WHERE query_text = ?')
        .get('old')
      expect(legacyRow).not.toBeNull()
      expect(legacyRow!.response_bytes).toBeNull()

      insertQueryLogEntry(db, baseEntry({ responseBytes: 42 }))
      const newRow = db
        .query<{ response_bytes: number | null }, [string]>('SELECT response_bytes FROM query_log WHERE query_text = ?')
        .get('legacy')
      expect(newRow).not.toBeNull()
      expect(newRow!.response_bytes).toBe(42)
    } finally {
      db.close()
    }

    // History was not wiped.
    const reopened = new Database(queriesPath)
    try {
      const count = reopened.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM query_log').get()
      expect(count!.n).toBe(2)
    } finally {
      reopened.close()
    }
  })

  test('ensureQueryLogSchema adds response_bytes without dropping rows', () => {
    const db = new Database(':memory:')
    try {
      db.run(`CREATE TABLE query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        tool TEXT NOT NULL,
        query_text TEXT,
        filters_json TEXT,
        result_count INTEGER NOT NULL,
        hit INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        top_qualified_names TEXT NOT NULL,
        error TEXT
      )`)
      db.run(
        `INSERT INTO query_log (timestamp, tool, query_text, filters_json, result_count, hit, latency_ms, top_qualified_names, error)
         VALUES ('2026-01-01T00:00:00.000Z', 'code_search', 'keep-me', NULL, 1, 1, 1, '[]', NULL)`,
      )
      db.run('PRAGMA user_version = 1')

      ensureQueryLogSchema(db)

      const row = db
        .query<{ response_bytes: number | null; query_text: string }, [string]>(
          'SELECT response_bytes, query_text FROM query_log WHERE query_text = ?',
        )
        .get('keep-me')
      expect(row).not.toBeNull()
      expect(row!.response_bytes).toBeNull()
      const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
      expect(version!.user_version).toBe(3)
    } finally {
      db.close()
    }
  })
})

describe('buildStructuredToolResult reports responseBytes', () => {
  test('responseBytes equals text + serialized structuredContent byte length', () => {
    const schema = z.object({ value: z.number() })
    const summary = '1 value'
    const structured = { value: 42 }
    const result = buildStructuredToolResult(schema, structured, summary)
    expect(result.responseBytes).toBe(
      Buffer.byteLength(summary, 'utf8') + Buffer.byteLength(JSON.stringify(structured), 'utf8'),
    )
  })
})
