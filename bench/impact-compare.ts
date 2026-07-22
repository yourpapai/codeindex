import type { ImpactBaseline, ImpactBenchReport } from './impact-types.js'

export interface ImpactComparison {
  readonly regressed: boolean
  readonly delta: number
}

// FN rate going UP means code_impact newly misses more true usages — a regression.
// FP rate is reported by the runner but not gated in Slice 1 (diagnostic only).
export const compareImpact = (
  report: ImpactBenchReport,
  baseline: ImpactBaseline,
  tolerance: number,
): ImpactComparison => {
  const delta = report.falseNegativeRate - baseline.falseNegativeRate
  return { regressed: delta > tolerance, delta }
}
