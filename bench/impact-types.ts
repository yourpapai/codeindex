import { z } from 'zod'

export interface OracleTarget {
  readonly target: string
  readonly trueSources: readonly string[]
}

export interface ImpactTargetScore {
  readonly target: string
  readonly trueSourceCount: number
  readonly impactSourceCount: number
  readonly falseNegatives: number
  readonly falsePositives: number
}

export interface ImpactBenchReport {
  readonly repo: string
  readonly targetsScored: number
  readonly trueReferenceCount: number
  readonly impactReferenceCount: number
  readonly falseNegatives: number
  readonly falseNegativeRate: number
  readonly falsePositives: number
  readonly falsePositiveRate: number
  readonly falsePositivesByConfidence: Readonly<Record<string, number>>
  readonly perTarget: readonly ImpactTargetScore[]
}

export interface ImpactBaseline {
  readonly targetsScored: number
  readonly trueReferenceCount: number
  readonly falseNegatives: number
  readonly falseNegativeRate: number
  readonly falsePositiveRate: number
}

export const ImpactBaselineSchema = z.object({
  targetsScored: z.number(),
  trueReferenceCount: z.number(),
  falseNegatives: z.number(),
  falseNegativeRate: z.number(),
  falsePositiveRate: z.number(),
})
