export interface RepoFile {
  readonly name: string
  readonly symbol: string
}

export interface RepoModel {
  readonly dir: string
  readonly files: readonly RepoFile[]
}

export type FuzzOperationKind = 'rename-symbol' | 'rename-file' | 'delete-file' | 'edit-content'

export interface FuzzOperation {
  readonly kind: FuzzOperationKind
  readonly target: string
}

export interface FuzzReport {
  readonly seed: number
  readonly sequencesRun: number
  readonly totalEdits: number
  readonly totalReferencesChecked: number
  readonly orphanedReferences: number
  readonly orphaningRate: number
  readonly danglingTargets: number
  readonly missingEdges: number
  readonly extraEdges: number
  readonly falseResolved: number
  readonly unexpectedUnresolved: number
  readonly mapRoutedDivergence: number
  readonly barrelRoutedDivergence: number
  readonly unexpectedImpactDivergence: number
  readonly mapRoutedImpactDivergence: number
  readonly barrelRoutedImpactDivergence: number
}
