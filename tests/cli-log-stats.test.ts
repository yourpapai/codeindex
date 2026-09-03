import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runLogStatsCommand } from '../src/cli.js'
import type { CodeindexConfig } from '../src/config.js'
import { insertQueryLogEntry, openQueryLog } from '../src/storage/query-log.js'

const configIn = (dir: string): CodeindexConfig => ({
  roots: ['src'],
  exclude: [],
  languages: ['ts'],
  dbPath: path.join(dir, 'index.db'),
  queriesPath: path.join(dir, 'queries.db'),
  logQueries: true,
  indexLocals: true,
  indexVariables: true,
  includeDocComments: true,
  maxStoredBodyLines: 120,
  maxFileSizeBytes: 1_000_000,
  tsconfigPaths: [path.join(dir, 'tsconfig.json')],
  repoRoot: dir,
  configPath: path.join(dir, '.codeindex.json'),
})

describe('runLogStatsCommand', () => {
  test('returns stats for the configured queries db', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-logstats-'))
    try {
      const config = configIn(dir)
      const db = openQueryLog(config.queriesPath)
      insertQueryLogEntry(db, {
        timestamp: '2026-07-21T00:00:00.000Z',
        tool: 'code_search',
        queryText: 'q',
        filtersJson: null,
        resultCount: 1,
        hit: true,
        latencyMs: 2,
        topQualifiedNames: [],
        error: null,
      })
      db.close()
      const stats = runLogStatsCommand(config)
      expect(stats.total).toBe(1)
      expect(stats.hits).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
