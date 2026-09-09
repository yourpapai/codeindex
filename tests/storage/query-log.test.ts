import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  ensureQueryLogSchema,
  insertQueryLogEntry,
  openQueryLog,
  readQueryLogStats,
} from '../../src/storage/query-log.js'
import type { QueryLogEntry } from '../../src/storage/query-log.js'

const baseEntry = (overrides: Partial<QueryLogEntry>): QueryLogEntry => ({
  timestamp: '2026-07-21T00:00:00.000Z',
  tool: 'code_search',
  queryText: 'searchSymbols',
  filtersJson: JSON.stringify({ limit: 10 }),
  resultCount: 1,
  hit: true,
  latencyMs: 3,
  topQualifiedNames: ['src/search/index#searchSymbols'],
  error: null,
  ...overrides,
})

describe('query log storage', () => {
  test('insert then stats aggregates count, hit rate, and latency percentiles', () => {
    const db = new Database(':memory:')
    try {
      ensureQueryLogSchema(db)
      insertQueryLogEntry(db, baseEntry({ latencyMs: 1, hit: true, resultCount: 2 }))
      insertQueryLogEntry(db, baseEntry({ latencyMs: 5, hit: false, resultCount: 0, topQualifiedNames: [] }))
      insertQueryLogEntry(db, baseEntry({ latencyMs: 9, hit: true, resultCount: 1 }))
      const stats = readQueryLogStats(db)
      expect(stats.total).toBe(3)
      expect(stats.hits).toBe(2)
      expect(stats.hitRate).toBeCloseTo(2 / 3)
      expect(stats.p50LatencyMs).toBe(5)
      expect(stats.maxLatencyMs).toBe(9)
    } finally {
      db.close()
    }
  })

  test('stats on an empty log are all zero, not NaN', () => {
    const db = new Database(':memory:')
    try {
      ensureQueryLogSchema(db)
      const stats = readQueryLogStats(db)
      expect(stats.total).toBe(0)
      expect(stats.hits).toBe(0)
      expect(stats.hitRate).toBe(0)
      expect(stats.p50LatencyMs).toBe(0)
    } finally {
      db.close()
    }
  })

  test('topQueries counts repeated query text', () => {
    const db = new Database(':memory:')
    try {
      ensureQueryLogSchema(db)
      insertQueryLogEntry(db, baseEntry({ queryText: 'foo' }))
      insertQueryLogEntry(db, baseEntry({ queryText: 'foo' }))
      insertQueryLogEntry(db, baseEntry({ queryText: 'bar' }))
      const stats = readQueryLogStats(db)
      const foo = stats.topQueries.find((entry) => entry.queryText === 'foo')
      expect(foo).not.toBeUndefined()
      expect(foo!.count).toBe(2)
    } finally {
      db.close()
    }
  })

  test('migrates a legacy queries.db missing the error column', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-legacy-qlog-'))
    try {
      const queriesPath = path.join(dir, 'queries.db')
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
          top_qualified_names TEXT NOT NULL
        )`)
      } finally {
        legacy.close()
      }
      const db = openQueryLog(queriesPath)
      try {
        insertQueryLogEntry(db, baseEntry({ error: 'no such column: error' }))
      } finally {
        db.close()
      }
      const reopened = new Database(queriesPath)
      try {
        const row = reopened.query<{ error: string | null }, []>('SELECT error FROM query_log').get()
        expect(row).not.toBeNull()
        expect(row!.error).toBe('no such column: error')
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
