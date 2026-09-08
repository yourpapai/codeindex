import type { IndexPhase } from '../src/indexer/index-codebase.js'

export type PhaseTimings = Readonly<Record<IndexPhase, number>>

export interface IndexBenchReport {
  readonly repo: string
  readonly mode: 'full' | 'incremental'
  readonly filesIndexed: number
  readonly filesFailed: number
  readonly filesPruned: number
  readonly symbolsIndexed: number
  readonly referencesIndexed: number
  readonly referencesUnresolved: number
  readonly elapsedMs: number
  readonly phaseMs: PhaseTimings
  readonly dbSizeBytes: number
  readonly filesPerSecond: number
  readonly symbolsPerSecond: number
  readonly referencesPerSecond: number
  readonly bunVersion: string
  readonly cpuCount: number
}

export interface IndexBaselineCounts {
  readonly filesIndexed: number
  readonly symbolsIndexed: number
  readonly referencesIndexed: number
  readonly referencesUnresolved: number
  readonly repoHead?: string | null
}
