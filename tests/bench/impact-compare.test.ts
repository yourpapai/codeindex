import { describe, expect, test } from 'bun:test'

import { compareImpact } from '../../bench/impact-compare.js'
import type { ImpactBaseline, ImpactBenchReport } from '../../bench/impact-types.js'

const baseline: ImpactBaseline = {
  targetsScored: 10,
  trueReferenceCount: 100,
  falseNegatives: 30,
  falseNegativeRate: 0.3,
  falsePositiveRate: 0.1,
  valueFalseNegativeRate: 0.3,
  typeFalseNegativeRate: 0.3,
}
const report = (fnRate: number): ImpactBenchReport => ({
  repo: 'x',
  targetsScored: 10,
  trueReferenceCount: 100,
  impactReferenceCount: 90,
  falseNegatives: Math.round(fnRate * 100),
  falseNegativeRate: fnRate,
  falsePositives: 9,
  falsePositiveRate: 0.1,
  falsePositivesByConfidence: {},
  valueTrueReferenceCount: 100,
  valueFalseNegatives: Math.round(fnRate * 100),
  valueFalseNegativeRate: fnRate,
  typeTrueReferenceCount: 0,
  typeFalseNegatives: 0,
  typeFalseNegativeRate: 0,
  perTarget: [],
})

describe('compareImpact', () => {
  test('FN rate increasing past tolerance is a regression', () => {
    expect(compareImpact(report(0.35), baseline, 1e-9).regressed).toBe(true)
  })
  test('FN rate dropping is an improvement, not a regression', () => {
    expect(compareImpact(report(0.2), baseline, 1e-9).regressed).toBe(false)
  })
})
