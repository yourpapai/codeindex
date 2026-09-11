export interface ImpactLookupInput {
  readonly symbolKey?: string
  readonly qualifiedName?: string
  readonly limit: number
}

export interface ImpactResult {
  readonly sourceQualifiedName: string | null
  readonly sourceFilePath: string
  readonly edgeType: string
  readonly confidence: string
  readonly lineNumber: number
}

export type ImpactIdentityMatchedBy = 'symbol_key' | 'qualified_name' | 'local_name' | 'module_name'

export interface ImpactIdentityCandidate {
  readonly symbolKey: string
  readonly qualifiedName: string
  readonly scopeTier: string
  readonly filePath: string
}

export type ImpactIdentityResolution =
  | {
      readonly status: 'canonical'
      readonly matchedBy: 'symbol_key' | 'qualified_name'
      readonly symbolKey: string
      readonly qualifiedName: string
    }
  | {
      readonly status: 'resolved'
      readonly matchedBy: 'qualified_name' | 'local_name' | 'module_name'
      readonly symbolKey: string
      readonly qualifiedName: string
    }
  | {
      readonly status: 'unresolved'
      readonly reason?: 'unknown' | 'ambiguous'
      readonly candidates?: readonly ImpactIdentityCandidate[]
    }

export interface ImpactLookupOutcome {
  readonly resolution: ImpactIdentityResolution
  readonly results: readonly ImpactResult[]
}

export interface SymbolIdentityRow {
  readonly id: number
  readonly symbol_key: string
  readonly qualified_name: string
  readonly scope_tier: string
  readonly module_key: string
  readonly file_path: string
}

export interface ResolvedImpactTarget {
  readonly id: number
  readonly resolution: ImpactIdentityResolution
}
