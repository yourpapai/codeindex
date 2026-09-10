import type { Database } from 'bun:sqlite'

import type { RankedSearchResult, SearchMode, SearchResult } from '../types.js'
import { runExactSearch, type SearchFilters } from './exact.js'
import { runFtsSearch } from './fts.js'
import { rerankSearchResults } from './rank.js'

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

export type ImpactIdentityMatchedBy = 'symbol_key' | 'qualified_name' | 'local_name'

export type ImpactIdentityResolution =
  | {
      readonly status: 'canonical'
      readonly matchedBy: 'symbol_key' | 'qualified_name'
      readonly symbolKey: string
      readonly qualifiedName: string
    }
  | {
      readonly status: 'resolved'
      readonly matchedBy: 'qualified_name' | 'local_name'
      readonly symbolKey: string
      readonly qualifiedName: string
    }
  | { readonly status: 'unresolved' }

export interface ImpactLookupOutcome {
  readonly resolution: ImpactIdentityResolution
  readonly results: readonly ImpactResult[]
}

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

interface SymbolIdentityRow {
  readonly id: number
  readonly symbol_key: string
  readonly qualified_name: string
}

const findSymbolIdByKey = (db: Database, symbolKey: string): SymbolIdentityRow | null =>
  db
    .query<SymbolIdentityRow, [string]>('SELECT id, symbol_key, qualified_name FROM symbols WHERE symbol_key = ?')
    .get(symbolKey)

const findSymbolIdByQualifiedName = (db: Database, qualifiedName: string): SymbolIdentityRow | null =>
  db
    .query<SymbolIdentityRow, [string]>(
      'SELECT id, symbol_key, qualified_name FROM symbols WHERE qualified_name = ?',
    )
    .get(qualifiedName)

const queryIncomingRows = (db: Database, targetSymbolId: number, limit: number): readonly ImpactResult[] =>
  db
    .query<
      {
        source_qualified_name: string | null
        source_file_path: string
        edge_type: string
        confidence: string
        line_number: number
      },
      [number, number]
    >(
      `SELECT source_symbols.qualified_name AS source_qualified_name,
              source_files.file_path AS source_file_path,
              symbol_references.edge_type,
              symbol_references.confidence,
              symbol_references.line_number
       FROM symbol_references
       JOIN files AS source_files ON source_files.id = symbol_references.source_file_id
       LEFT JOIN symbols AS source_symbols ON source_symbols.id = symbol_references.source_symbol_id
       WHERE symbol_references.target_symbol_id = ?
       ORDER BY symbol_references.confidence = 'resolved' DESC, symbol_references.line_number ASC
       LIMIT ?`,
    )
    .all(targetSymbolId, limit)
    .map((row) => ({
      sourceQualifiedName: row.source_qualified_name,
      sourceFilePath: row.source_file_path,
      edgeType: row.edge_type,
      confidence: row.confidence,
      lineNumber: row.line_number,
    }))

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

interface ResolvedImpactTarget {
  readonly id: number
  readonly resolution: ImpactIdentityResolution
}

const canonicalResolution = (
  row: SymbolIdentityRow,
  matchedBy: 'symbol_key' | 'qualified_name',
): ResolvedImpactTarget => ({
  id: row.id,
  resolution: {
    status: 'canonical',
    matchedBy,
    symbolKey: row.symbol_key,
    qualifiedName: row.qualified_name,
  },
})

// Spec stage 1: try the canonical columns in input order — symbol_key when symbolKey is
// given, then qualified_name when qualifiedName is given.
const resolveCanonicalTarget = (
  db: Database,
  input: Readonly<ImpactLookupInput>,
): ResolvedImpactTarget | undefined => {
  if (input.symbolKey !== undefined) {
    const row = findSymbolIdByKey(db, input.symbolKey)
    if (row !== null) {
      return canonicalResolution(row, 'symbol_key')
    }
  }
  if (input.qualifiedName !== undefined) {
    const row = findSymbolIdByQualifiedName(db, input.qualifiedName)
    if (row !== null) {
      return canonicalResolution(row, 'qualified_name')
    }
  }
  return undefined
}

// Spec stage 2: the exact stage of the candidate router (runExactSearch + rerank) — no FTS
// fallback. Only exact-name identity forms count: exact_qualified / exact_local. Path-prefix
// and export-name matches are deliberately not accepted identity forms.
const resolveExactCandidate = (db: Database, identity: string, limit: number): ResolvedImpactTarget | undefined => {
  const top = rerankSearchResults(runExactSearch(db, identity, limit, {})).find(
    (candidate) => candidate.matchedBy === 'exact_qualified' || candidate.matchedBy === 'exact_local',
  )
  if (top === undefined) {
    return undefined
  }
  const row = findSymbolIdByKey(db, top.symbolKey)
  if (row === null) {
    return undefined
  }
  return {
    id: row.id,
    resolution: {
      status: 'resolved',
      matchedBy: top.matchedBy === 'exact_qualified' ? 'qualified_name' : 'local_name',
      symbolKey: row.symbol_key,
      qualifiedName: row.qualified_name,
    },
  }
}

export const resolveIncomingReferences = (db: Database, input: Readonly<ImpactLookupInput>): ImpactLookupOutcome => {
  if (input.symbolKey === undefined && input.qualifiedName === undefined) {
    throw new Error('Either symbolKey or qualifiedName is required')
  }

  const canonical = resolveCanonicalTarget(db, input)
  if (canonical !== undefined) {
    return { resolution: canonical.resolution, results: queryIncomingRows(db, canonical.id, input.limit) }
  }

  const identityInputs: readonly string[] = [input.symbolKey, input.qualifiedName].filter(
    (value): value is string => value !== undefined,
  )
  for (const identity of identityInputs) {
    const resolved = resolveExactCandidate(db, identity, input.limit)
    if (resolved !== undefined) {
      return { resolution: resolved.resolution, results: queryIncomingRows(db, resolved.id, input.limit) }
    }
  }
  return { resolution: { status: 'unresolved' }, results: [] }
}
