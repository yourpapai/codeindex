export type GoldenQueryKind = 'find-symbol' | 'nl-intent' | 'who-uses'

export interface FindQuery {
  readonly id: string
  readonly kind: 'find-symbol' | 'nl-intent'
  readonly query: string
  readonly relevant: readonly string[]
}

export interface WhoUsesQuery {
  readonly id: string
  readonly kind: 'who-uses'
  readonly target: string
  readonly relevant: readonly string[]
}

export type GoldenQuery = FindQuery | WhoUsesQuery

export interface Corpus {
  readonly name: string
  readonly queries: readonly GoldenQuery[]
}

export interface QueryScore {
  readonly id: string
  readonly kind: GoldenQueryKind
  readonly precisionAtK: number
  readonly recallAtK: number
  readonly reciprocalRank: number
  readonly retrieved: readonly string[]
  readonly relevant: readonly string[]
}

export interface CorpusReport {
  readonly k: number
  readonly queryCount: number
  readonly meanPrecisionAtK: number
  readonly meanRecallAtK: number
  readonly mrr: number
  readonly perQuery: readonly QueryScore[]
}

export interface BaselineMetrics {
  readonly k: number
  readonly meanPrecisionAtK: number
  readonly meanRecallAtK: number
  readonly mrr: number
  readonly repoHead?: string | null
}
