import { describe, expect, test } from 'bun:test'

import { compareIndexCounts } from '../../bench/index-bench-compare.js'
import type { IndexBaselineCounts, IndexBenchReport } from '../../bench/index-bench-types.js'

const report = (overrides: Partial<IndexBenchReport>): IndexBenchReport => ({
  repo: '/x',
  mode: 'full',
  filesIndexed: 10,
  filesFailed: 0,
  filesPruned: 0,
  symbolsIndexed: 100,
  referencesIndexed: 200,
  referencesUnresolved: 50,
  elapsedMs: 5,
  phaseMs: { init: 0, discover: 0, parse: 0, persist: 0, resolve: 0, provenance: 0 },
  dbSizeBytes: 1,
  filesPerSecond: 0,
  symbolsPerSecond: 0,
  referencesPerSecond: 0,
  bunVersion: '1',
  cpuCount: 1,
  ...overrides,
})

const baseline: IndexBaselineCounts = {
  filesIndexed: 10,
  symbolsIndexed: 100,
  referencesIndexed: 200,
  referencesUnresolved: 50,
}

describe('compareIndexCounts', () => {
  test('flags a drop in indexed symbols', () => {
    expect(compareIndexCounts(report({ symbolsIndexed: 90 }), baseline, 0).regressed).toBe(true)
  })

  test('does not flag equal counts', () => {
    expect(compareIndexCounts(report({}), baseline, 0).regressed).toBe(false)
  })

  test('does not flag an increase (repo grew)', () => {
    expect(compareIndexCounts(report({ symbolsIndexed: 120, filesIndexed: 12 }), baseline, 0).regressed).toBe(false)
  })
})
