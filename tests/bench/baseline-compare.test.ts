import { describe, expect, test } from 'bun:test'

import { compareToBaseline } from '../../bench/baseline-compare.js'
import type { BaselineMetrics, CorpusReport } from '../../bench/types.js'

const buildReport = (overrides: Partial<CorpusReport>): CorpusReport => ({
  k: 10,
  queryCount: 1,
  meanPrecisionAtK: 0.5,
  meanRecallAtK: 0.5,
  mrr: 0.5,
  perQuery: [],
  ...overrides,
})

const baseline: BaselineMetrics = { k: 10, meanPrecisionAtK: 0.5, meanRecallAtK: 0.5, mrr: 0.5 }

describe('compareToBaseline', () => {
  test('flags regression when a metric drops beyond tolerance', () => {
    expect(compareToBaseline(buildReport({ mrr: 0.4 }), baseline, 1e-9).regressed).toBe(true)
  })

  test('does not flag equal metrics', () => {
    expect(compareToBaseline(buildReport({}), baseline, 1e-9).regressed).toBe(false)
  })

  test('does not flag improvements', () => {
    expect(compareToBaseline(buildReport({ mrr: 0.9 }), baseline, 1e-9).regressed).toBe(false)
  })
})
