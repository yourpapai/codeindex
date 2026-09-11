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

  test('schema v3 is additive: prior history survives and new columns appear', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-qlog-v3-'))
    try {
      const queriesPath = path.join(dir, 'queries.db')
      const prior = openQueryLog(queriesPath)
      try {
        insertQueryLogEntry(
          prior,
          baseEntry({
            queryText: 'openDatabase',
            resultCount: 2,
            responseBytes: 120,
          }),
        )
        expect(
          prior.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version,
        ).toBeGreaterThanOrEqual(2)
      } finally {
        prior.close()
      }

      const migrated = openQueryLog(queriesPath)
      try {
        const version = migrated.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version
        expect(version).toBeGreaterThanOrEqual(3)

        const columns = migrated
          .query<{ name: string }, []>('PRAGMA table_info(query_log)')
          .all()
          .map((row) => row.name)
        expect(columns).toContain('query_shape')
        expect(columns).toContain('zero_or_weak')
        expect(columns).toContain('mode')
        expect(columns).toContain('matched_by')
        expect(columns).toContain('response_bytes')

        const history = migrated
          .query<
            {
              query_text: string
              result_count: number
              response_bytes: number | null
              query_shape: string | null
              zero_or_weak: number | null
              mode: string | null
              matched_by: string | null
            },
            []
          >(
            'SELECT query_text, result_count, response_bytes, query_shape, zero_or_weak, mode, matched_by FROM query_log',
          )
          .all()
        expect(history).toHaveLength(1)
        expect(history[0]!.query_text).toBe('openDatabase')
        expect(history[0]!.result_count).toBe(2)
        expect(history[0]!.response_bytes).toBe(120)
        expect(history[0]!.query_shape).toBeNull()
        expect(history[0]!.zero_or_weak).toBeNull()
        expect(history[0]!.mode).toBeNull()
        expect(history[0]!.matched_by).toBeNull()

        insertQueryLogEntry(
          migrated,
          baseEntry({
            queryText: 'find me',
            resultCount: 0,
            queryShape: 'nl',
            zeroOrWeak: true,
            mode: 'exact',
            matchedBy: 'exact_export',
          }),
        )
        const newest = migrated
          .query<
            {
              query_text: string
              query_shape: string | null
              zero_or_weak: number | null
              mode: string | null
              matched_by: string | null
            },
            []
          >(
            `SELECT query_text, query_shape, zero_or_weak, mode, matched_by
             FROM query_log ORDER BY id DESC LIMIT 1`,
          )
          .get()
        expect(newest!.query_text).toBe('find me')
        expect(newest!.query_shape).toBe('nl')
        expect(newest!.zero_or_weak).toBe(1)
        expect(newest!.mode).toBe('exact')
        expect(newest!.matched_by).toBe('exact_export')
      } finally {
        migrated.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fresh database is created at schema v3 with telemetry columns present', () => {
    const db = new Database(':memory:')
    try {
      ensureQueryLogSchema(db)
      const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version
      expect(version).toBeGreaterThanOrEqual(3)
      const columns = db
        .query<{ name: string }, []>('PRAGMA table_info(query_log)')
        .all()
        .map((row) => row.name)
      for (const name of ['query_shape', 'zero_or_weak', 'mode', 'matched_by'] as const) {
        expect(columns).toContain(name)
      }
    } finally {
      db.close()
    }
  })
})
