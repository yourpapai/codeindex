export type SupportedLanguage = 'ts' | 'tsx' | 'js' | 'jsx'

export type ScopeTier = 'exported' | 'module' | 'member' | 'local'

export type ExportKind = 'named' | 'default' | 'namespace' | 'reexport' | 'star'

export type ReferenceEdgeType =
  | 'imports'
  | 'reexports'
  | 'calls'
  | 'extends'
  | 'implements'
  | 'references'
  | 'type_refs'

export type ReferenceConfidence = 'resolved' | 'file_resolved' | 'name_only'

export type MatchedBy = 'exact_export' | 'exact_qualified' | 'exact_local' | 'path_prefix' | 'fts'

export type SearchMode = 'auto' | 'exact' | 'fts' | 'fused'

export interface SearchResult {
  readonly symbolKey: string
  readonly qualifiedName: string
  readonly localName: string
  readonly kind: string
  readonly scopeTier: ScopeTier
  readonly filePath: string
  readonly startLine: number
  readonly endLine: number
  readonly exportNames: readonly string[]
  readonly matchedBy: MatchedBy
  readonly confidence: ReferenceConfidence | 'exact'
  readonly snippet: string
  readonly relevance?: number
  readonly inDegree?: number
}

export interface RankedSearchResult extends SearchResult {
  readonly rankScore: number
}
