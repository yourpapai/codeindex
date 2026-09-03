import { z } from 'zod'

export type Shape =
  | 'call'
  | 'construct'
  | 'member'
  | 'namespace'
  | 'jsx'
  | 'heritage'
  | 'bare-value'
  | 'property-unknown'
  | 'other'

export interface OracleSource {
  readonly name: string
  readonly position: 'value' | 'type' | 'both'
  readonly shapes: readonly Shape[]
}

export interface OracleTarget {
  readonly target: string
  readonly trueSources: readonly OracleSource[]
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
  readonly valueTrueReferenceCount: number
  readonly valueFalseNegatives: number
  readonly valueFalseNegativeRate: number
  readonly typeTrueReferenceCount: number
  readonly typeFalseNegatives: number
  readonly typeFalseNegativeRate: number
  readonly valueTrueReferenceCountByShape: Readonly<Record<string, number>>
  readonly valueFalseNegativesByShape: Readonly<Record<string, number>>
  readonly typeTrueReferenceCountByShape: Readonly<Record<string, number>>
  readonly typeFalseNegativesByShape: Readonly<Record<string, number>>
  readonly perTarget: readonly ImpactTargetScore[]
}

export interface ImpactBaseline {
  readonly targetsScored: number
  readonly trueReferenceCount: number
  readonly falseNegatives: number
  readonly falseNegativeRate: number
  readonly falsePositiveRate: number
  readonly valueFalseNegativeRate: number
  readonly typeFalseNegativeRate: number
}

export const ImpactBaselineSchema = z.object({
  targetsScored: z.number(),
  trueReferenceCount: z.number(),
  falseNegatives: z.number(),
  falseNegativeRate: z.number(),
  falsePositiveRate: z.number(),
  valueFalseNegativeRate: z.number(),
  typeFalseNegativeRate: z.number(),
})
