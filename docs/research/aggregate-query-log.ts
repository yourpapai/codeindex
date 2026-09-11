#!/usr/bin/env bun
/**
 * Offline aggregate for dogfood query_log corpora.
 *
 * Usage:
 *   bun run docs/research/aggregate-query-log.ts <queries.db> [more.db ...]
 *
 * Prints tool × shape × zero/weak counts. Stored query_shape/zero_or_weak are
 * preferred when present; historical rows without them are classified on the
 * fly with the same deterministic helper used by live telemetry.
 */
import { Database } from 'bun:sqlite'
import path from 'node:path'

import { classifyQueryShape, isZeroOrWeakResult } from '../../src/mcp/query-shape.js'

interface Aggregate {
  readonly total: number
  readonly zeros: number
  readonly weak: number
  readonly byTool: Record<string, { total: number; zeros: number; weak: number }>
  readonly byShape: Record<string, number>
  readonly toolShape: Record<string, Record<string, number>>
}

const emptyAgg = (): Aggregate => ({
  total: 0,
  zeros: 0,
  weak: 0,
  byTool: {},
  byShape: {},
  toolShape: {},
})

const bump = (
  map: Record<string, { total: number; zeros: number; weak: number }>,
  key: string,
  isZero: boolean,
  isWeak: boolean,
): void => {
  const entry = map[key] ?? { total: 0, zeros: 0, weak: 0 }
  entry.total += 1
  if (isZero) entry.zeros += 1
  if (isWeak) entry.weak += 1
  map[key] = entry
}

export const aggregateQueryLog = (queriesPath: string): Aggregate => {
  const db = new Database(queriesPath, { readonly: true })
  try {
    const columns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(query_log)')
        .all()
        .map((row) => row.name),
    )
    if (!columns.has('query_text')) {
      throw new Error(`No query_log table in ${queriesPath}`)
    }
    const hasShape = columns.has('query_shape')
    const hasWeak = columns.has('zero_or_weak')
    const selectShape = hasShape ? 'query_shape' : 'NULL AS query_shape'
    const selectWeak = hasWeak ? 'zero_or_weak' : 'NULL AS zero_or_weak'
    const rows = db
      .query<
        {
          tool: string
          query_text: string | null
          result_count: number
          query_shape: string | null
          zero_or_weak: number | null
        },
        []
      >(
        `SELECT tool, query_text, result_count, ${selectShape}, ${selectWeak} FROM query_log`,
      )
      .all()

    const agg = emptyAgg()
    for (const row of rows) {
      const shape = row.query_shape ?? classifyQueryShape(row.query_text)
      const isZero = row.result_count === 0
      const isWeak =
        row.zero_or_weak === null || row.zero_or_weak === undefined
          ? isZeroOrWeakResult(row.result_count)
          : row.zero_or_weak === 1
      agg.total += 1
      if (isZero) agg.zeros += 1
      if (isWeak) agg.weak += 1
      bump(agg.byTool, row.tool, isZero, isWeak)
      agg.byShape[shape] = (agg.byShape[shape] ?? 0) + 1
      const toolShapes = agg.toolShape[row.tool] ?? {}
      toolShapes[shape] = (toolShapes[shape] ?? 0) + 1
      agg.toolShape[row.tool] = toolShapes
    }
    return agg
  } finally {
    db.close()
  }
}

const mergeAgg = (left: Aggregate, right: Aggregate): Aggregate => {
  const byTool: Aggregate['byTool'] = {}
  for (const key of new Set([...Object.keys(left.byTool), ...Object.keys(right.byTool)])) {
    const a = left.byTool[key] ?? { total: 0, zeros: 0, weak: 0 }
    const b = right.byTool[key] ?? { total: 0, zeros: 0, weak: 0 }
    byTool[key] = { total: a.total + b.total, zeros: a.zeros + b.zeros, weak: a.weak + b.weak }
  }
  const byShape: Aggregate['byShape'] = {}
  for (const key of new Set([...Object.keys(left.byShape), ...Object.keys(right.byShape)])) {
    byShape[key] = (left.byShape[key] ?? 0) + (right.byShape[key] ?? 0)
  }
  return {
    total: left.total + right.total,
    zeros: left.zeros + right.zeros,
    weak: left.weak + right.weak,
    byTool,
    byShape,
    toolShape: left.toolShape,
  }
}

const main = (): void => {
  const paths = process.argv.slice(2)
  if (paths.length === 0) {
    console.error('Usage: bun run docs/research/aggregate-query-log.ts <queries.db> [more.db ...]')
    process.exit(1)
  }
  const report: Record<string, Aggregate> = {}
  let combined = emptyAgg()
  for (const queriesPath of paths) {
    const agg = aggregateQueryLog(path.resolve(queriesPath))
    report[queriesPath] = agg
    combined = mergeAgg(combined, agg)
  }
  console.log(JSON.stringify({ perDb: report, combined }, null, 2))
}

if (import.meta.main) {
  main()
}
