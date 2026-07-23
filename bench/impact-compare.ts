import type { ImpactBaseline, ImpactBenchReport } from './impact-types.js'

export interface ImpactComparison {
  readonly regressed: boolean
  readonly delta: number
}

// Value-position FN going UP means code_impact newly misses more real (value) usages —
// a regression. Type-only FN, total FN, and FP are diagnostics, not gated (Slice 2).
export const compareImpact = (
  report: ImpactBenchReport,
  baseline: ImpactBaseline,
  tolerance: number,
): ImpactComparison => {
  const delta = report.valueFalseNegativeRate - baseline.valueFalseNegativeRate
  return { regressed: delta > tolerance, delta }
}
