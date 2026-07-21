import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { ensureQueryLogSchema, insertQueryLogEntry, readQueryLogStats } from '../../src/storage/query-log.js'
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
})
