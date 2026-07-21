import type { Database } from 'bun:sqlite'

import { openDatabase } from './db.js'

export interface QueryLogEntry {
  readonly timestamp: string
  readonly tool: string
  readonly queryText: string | null
  readonly filtersJson: string | null
  readonly resultCount: number
  readonly hit: boolean
  readonly latencyMs: number
  readonly topQualifiedNames: readonly string[]
  readonly error: string | null
}

export interface TopQuery {
  readonly queryText: string
  readonly count: number
}

export interface QueryLogStats {
  readonly total: number
  readonly hits: number
  readonly hitRate: number
  readonly p50LatencyMs: number
  readonly p95LatencyMs: number
  readonly maxLatencyMs: number
  readonly topQueries: readonly TopQuery[]
}

const CREATE_QUERY_LOG = `CREATE TABLE IF NOT EXISTS query_log (
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
)`

export const ensureQueryLogSchema = (db: Database): void => {
  db.run(CREATE_QUERY_LOG)
}

export const openQueryLog = (queriesPath: string): Database => {
  const db = openDatabase(queriesPath)
  ensureQueryLogSchema(db)
  return db
}

export const insertQueryLogEntry = (db: Database, entry: QueryLogEntry): void => {
  db.query(
    `INSERT INTO query_log (timestamp, tool, query_text, filters_json, result_count, hit, latency_ms, top_qualified_names, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.timestamp,
    entry.tool,
    entry.queryText,
    entry.filtersJson,
    entry.resultCount,
    entry.hit ? 1 : 0,
    entry.latencyMs,
    JSON.stringify(entry.topQualifiedNames),
    entry.error,
  )
}

const percentile = (sortedAscending: readonly number[], fraction: number): number => {
  if (sortedAscending.length === 0) {
    return 0
  }
  const index = Math.min(sortedAscending.length - 1, Math.floor(fraction * sortedAscending.length))
  return sortedAscending[index] ?? 0
}

interface LatencyRow {
  readonly latency_ms: number
}

interface TopQueryRow {
  readonly query_text: string
  readonly n: number
}

export const readQueryLogStats = (db: Database): QueryLogStats => {
  const latencies = db
    .query<LatencyRow, []>('SELECT latency_ms FROM query_log ORDER BY latency_ms ASC')
    .all()
    .map((row) => row.latency_ms)
  const total = latencies.length
  const hitsRow = db.query<{ hits: number }, []>('SELECT COUNT(*) AS hits FROM query_log WHERE hit = 1').get()
  const hits = hitsRow === null ? 0 : hitsRow.hits
  const topQueries = db
    .query<TopQueryRow, []>(
      `SELECT query_text, COUNT(*) AS n FROM query_log
       WHERE query_text IS NOT NULL
       GROUP BY query_text ORDER BY n DESC, query_text ASC LIMIT 10`,
    )
    .all()
    .map((row) => ({ queryText: row.query_text, count: row.n }))
  return {
    total,
    hits,
    hitRate: total === 0 ? 0 : hits / total,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    maxLatencyMs: total === 0 ? 0 : (latencies[total - 1] ?? 0),
    topQueries,
  }
}
