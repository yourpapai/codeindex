import type { Database } from 'bun:sqlite'

import type { RankedSearchResult, SearchMode, SearchResult } from '../types.js'
import { runExactSearch, type SearchFilters } from './exact.js'
import { runFtsSearch } from './fts.js'
import { findSymbolIdByKey, findSymbolIdByQualifiedName, queryIncomingRows } from './impact-identity.js'
import type { ImpactLookupInput, ImpactResult } from './impact-types.js'
import { rerankSearchResults } from './rank.js'
import { resolveIncomingReferences } from './resolve-impact.js'

export type {
  ImpactIdentityCandidate,
  ImpactIdentityMatchedBy,
  ImpactIdentityResolution,
  ImpactLookupInput,
  ImpactLookupOutcome,
  ImpactResult,
} from './impact-types.js'

export { resolveIncomingReferences }

export const searchSymbols = (
  db: Database,
  input: Readonly<{ query: string; limit: number; mode?: SearchMode } & SearchFilters>,
): readonly RankedSearchResult[] => {
  const mode: SearchMode = input.mode ?? 'auto'
  const servesUnion = mode === 'auto' || mode === 'fused'
  const exactResults = servesUnion || mode === 'exact' ? runExactSearch(db, input.query, input.limit, input) : []
  const ftsResults = servesUnion || mode === 'fts' ? runFtsSearch(db, input.query, input.limit, input) : []
  const deduped: readonly SearchResult[] = [
    ...exactResults,
    ...ftsResults.filter((fts) => !exactResults.some((exact) => exact.symbolKey === fts.symbolKey)),
  ]
  return rerankSearchResults(deduped).slice(0, input.limit)
}

export const findSymbolCandidates = (db: Database, query: string, limit: number): readonly RankedSearchResult[] => {
  const exactResults = runExactSearch(db, query, limit, {})
  if (exactResults.length > 0) {
    return rerankSearchResults(exactResults)
  }
  return searchSymbols(db, { query, limit })
}

export const findIncomingReferences = (db: Database, input: Readonly<ImpactLookupInput>): readonly ImpactResult[] => {
  if (input.symbolKey === undefined && input.qualifiedName === undefined) {
    throw new Error('Either symbolKey or qualifiedName is required')
  }

  const targetRow =
    input.symbolKey === undefined
      ? findSymbolIdByQualifiedName(db, input.qualifiedName ?? '')
      : findSymbolIdByKey(db, input.symbolKey)

  if (targetRow === null) {
    return []
  }

  return queryIncomingRows(db, targetRow.id, input.limit)
}
