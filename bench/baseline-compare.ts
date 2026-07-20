import type { BaselineMetrics, CorpusReport } from './types.js'

export interface MetricDelta {
  readonly metric: 'meanPrecisionAtK' | 'meanRecallAtK' | 'mrr'
  readonly baseline: number
  readonly current: number
  readonly delta: number
}

export interface BaselineComparison {
  readonly regressed: boolean
  readonly deltas: readonly MetricDelta[]
}

export const compareToBaseline = (
  report: CorpusReport,
  baseline: BaselineMetrics,
  tolerance: number,
): BaselineComparison => {
  const deltas: readonly MetricDelta[] = [
    {
      metric: 'meanPrecisionAtK',
      baseline: baseline.meanPrecisionAtK,
      current: report.meanPrecisionAtK,
      delta: report.meanPrecisionAtK - baseline.meanPrecisionAtK,
    },
    {
      metric: 'meanRecallAtK',
      baseline: baseline.meanRecallAtK,
      current: report.meanRecallAtK,
      delta: report.meanRecallAtK - baseline.meanRecallAtK,
    },
    {
      metric: 'mrr',
      baseline: baseline.mrr,
      current: report.mrr,
      delta: report.mrr - baseline.mrr,
    },
  ]
  return { regressed: deltas.some((entry) => entry.delta < -tolerance), deltas }
}
