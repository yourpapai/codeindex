import { describe, expect, test } from 'bun:test'

import { compareImpact } from '../../bench/impact-compare.js'
import type { ImpactBaseline, ImpactBenchReport } from '../../bench/impact-types.js'

const baseline: ImpactBaseline = {
  targetsScored: 10,
  trueReferenceCount: 100,
  falseNegatives: 30,
  falseNegativeRate: 0.3,
  falsePositiveRate: 0.1,
  valueFalseNegativeRate: 0.5,
  typeFalseNegativeRate: 0.9,
}
const report = (valueFnRate: number): ImpactBenchReport => ({
  repo: 'x',
  targetsScored: 10,
  trueReferenceCount: 100,
  impactReferenceCount: 90,
  falseNegatives: 30,
  falseNegativeRate: 0.3,
  falsePositives: 9,
  falsePositiveRate: 0.1,
  falsePositivesByConfidence: {},
  valueTrueReferenceCount: 50,
  valueFalseNegatives: Math.round(valueFnRate * 50),
  valueFalseNegativeRate: valueFnRate,
  typeTrueReferenceCount: 50,
  typeFalseNegatives: 45,
  typeFalseNegativeRate: 0.9,
  perTarget: [],
})

describe('compareImpact', () => {
  test('value FN rate increasing past tolerance is a regression', () => {
    expect(compareImpact(report(0.55), baseline, 1e-9).regressed).toBe(true)
  })
  test('value FN rate dropping is an improvement, not a regression', () => {
    expect(compareImpact(report(0.4), baseline, 1e-9).regressed).toBe(false)
  })
})
