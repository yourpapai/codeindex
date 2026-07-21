import type { IndexBaselineCounts, IndexBenchReport } from './index-bench-types.js'

export interface IndexCountDelta {
  readonly metric: keyof IndexBaselineCounts
  readonly baseline: number
  readonly current: number
  readonly delta: number
}

export interface IndexCountComparison {
  readonly regressed: boolean
  readonly deltas: readonly IndexCountDelta[]
}

export const compareIndexCounts = (
  report: IndexBenchReport,
  baseline: IndexBaselineCounts,
  tolerance: number,
): IndexCountComparison => {
  const metrics: readonly (keyof IndexBaselineCounts)[] = [
    'filesIndexed',
    'symbolsIndexed',
    'referencesIndexed',
    'referencesUnresolved',
  ]
  const deltas: readonly IndexCountDelta[] = metrics.map((metric) => ({
    metric,
    baseline: baseline[metric],
    current: report[metric],
    delta: report[metric] - baseline[metric],
  }))
  // Only the "more is expected" counts gate on a decrease. referencesUnresolved dropping is an improvement,
  // so it is reported but never flags a regression.
  const gated: readonly (keyof IndexBaselineCounts)[] = ['filesIndexed', 'symbolsIndexed', 'referencesIndexed']
  const regressed = deltas.some((entry) => gated.includes(entry.metric) && entry.delta < -tolerance)
  return { regressed, deltas }
}
