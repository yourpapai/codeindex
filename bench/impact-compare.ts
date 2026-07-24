import type { ImpactBaseline, ImpactBenchReport } from './impact-types.js'

export interface ImpactComparison {
  readonly regressed: boolean
  readonly delta: number
  readonly fpDelta: number
}

// Two gates. (1) Value-position FN going UP means code_impact newly misses more real (value) usages.
// (2) FP rate going UP means it newly reports usages that do not exist — gated since Slice 5c (B6),
// whose bare-value edges are the first change with real FP risk; the guard keeps papai at 0 FP and
// this locks that in. Type-only FN and total FN remain diagnostics.
export const compareImpact = (
  report: ImpactBenchReport,
  baseline: ImpactBaseline,
  tolerance: number,
): ImpactComparison => {
  const delta = report.valueFalseNegativeRate - baseline.valueFalseNegativeRate
  const fpDelta = report.falsePositiveRate - baseline.falsePositiveRate
  return { regressed: delta > tolerance || fpDelta > tolerance, delta, fpDelta }
}
