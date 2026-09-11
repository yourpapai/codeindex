import type { Database } from 'bun:sqlite'

import type {
  ImpactIdentityCandidate,
  ImpactIdentityResolution,
  ResolvedImpactTarget,
  SymbolIdentityRow,
} from './impact-types.js'

export const queryIncomingRows = (
  db: Database,
  targetSymbolId: number,
  limit: number,
): readonly import('./impact-types.js').ImpactResult[] =>
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

const findSymbolIdByKey = (db: Database, symbolKey: string): SymbolIdentityRow | null =>
  db
    .query<SymbolIdentityRow, [string]>(
      'SELECT id, symbol_key, qualified_name, scope_tier, module_key, file_path FROM symbols WHERE symbol_key = ?',
    )
    .get(symbolKey)

const findSymbolIdByQualifiedName = (db: Database, qualifiedName: string): SymbolIdentityRow | null =>
  db
    .query<SymbolIdentityRow, [string]>(
      'SELECT id, symbol_key, qualified_name, scope_tier, module_key, file_path FROM symbols WHERE qualified_name = ?',
    )
    .get(qualifiedName)

const findSymbolsByLocalName = (db: Database, localName: string): readonly SymbolIdentityRow[] =>
  db
    .query<SymbolIdentityRow, [string]>(
      'SELECT id, symbol_key, qualified_name, scope_tier, module_key, file_path FROM symbols WHERE local_name = ?',
    )
    .all(localName)

const findSymbolsByModulePartial = (
  db: Database,
  moduleName: string,
  localName: string,
): readonly SymbolIdentityRow[] =>
  db
    .query<SymbolIdentityRow, [string, string, string]>(
      `SELECT id, symbol_key, qualified_name, scope_tier, module_key, file_path
       FROM symbols
       WHERE local_name = ?
         AND (module_key = ? OR module_key LIKE '%/' || ?)`,
    )
    .all(localName, moduleName, moduleName)

export { findSymbolIdByKey, findSymbolIdByQualifiedName, findSymbolsByLocalName }

export const canonicalResolution = (
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
export const resolveCanonicalTarget = (
  db: Database,
  input: Readonly<{ symbolKey?: string; qualifiedName?: string }>,
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

// Spec stage 2: exact identity columns only — no FTS candidacy, no rank-order pick.
// A bare local name is accepted iff exactly one indexed symbol has that local_name,
// or (among multi-matches) exactly one of them is scope_tier='exported'.
const resolveExactCandidate = (db: Database, identity: string): ResolvedImpactTarget | undefined => {
  const byQualified = findSymbolIdByQualifiedName(db, identity)
  if (byQualified !== null) {
    return {
      id: byQualified.id,
      resolution: {
        status: 'resolved',
        matchedBy: 'qualified_name',
        symbolKey: byQualified.symbol_key,
        qualifiedName: byQualified.qualified_name,
      },
    }
  }

  const byLocalName = findSymbolsByLocalName(db, identity)
  if (byLocalName.length === 1) {
    const row = byLocalName[0]!
    return {
      id: row.id,
      resolution: {
        status: 'resolved',
        matchedBy: 'local_name',
        symbolKey: row.symbol_key,
        qualifiedName: row.qualified_name,
      },
    }
  }

  // Lever A: unique-export cardinality. Never pick among two+ exports.
  if (byLocalName.length > 1) {
    const exported = byLocalName.filter((row) => row.scope_tier === 'exported')
    if (exported.length === 1) {
      const row = exported[0]!
      return {
        id: row.id,
        resolution: {
          status: 'resolved',
          matchedBy: 'local_name',
          symbolKey: row.symbol_key,
          qualifiedName: row.qualified_name,
        },
      }
    }
  }

  return undefined
}

// Lever C: Module#Name partial. Segment-exact module_key match only.
const MODULE_NAME_PARTIAL = /^([^/#>]+)#([^/#>]+)$/

export type ExactCandidateOutcome =
  | { readonly kind: 'resolved'; readonly target: ResolvedImpactTarget }
  | { readonly kind: 'ambiguous_partial'; readonly rows: readonly SymbolIdentityRow[] }

export const resolveExactOrPartialCandidate = (db: Database, identity: string): ExactCandidateOutcome | undefined => {
  const resolved = resolveExactCandidate(db, identity)
  if (resolved !== undefined) {
    return { kind: 'resolved', target: resolved }
  }

  const partial = MODULE_NAME_PARTIAL.exec(identity)
  if (partial === null) {
    return undefined
  }
  const moduleName = partial[1]!
  const localName = partial[2]!
  const rows = findSymbolsByModulePartial(db, moduleName, localName)
  if (rows.length === 1) {
    const row = rows[0]!
    return {
      kind: 'resolved',
      target: {
        id: row.id,
        resolution: {
          status: 'resolved',
          matchedBy: 'module_name',
          symbolKey: row.symbol_key,
          qualifiedName: row.qualified_name,
        },
      },
    }
  }
  if (rows.length > 1) {
    return { kind: 'ambiguous_partial', rows }
  }
  return undefined
}

const AMBIGUITY_CANDIDATE_CAP = 5

const toIdentityCandidate = (row: SymbolIdentityRow): ImpactIdentityCandidate => ({
  symbolKey: row.symbol_key,
  qualifiedName: row.qualified_name,
  scopeTier: row.scope_tier,
  filePath: row.file_path,
})

export const rankAmbiguousCandidates = (rows: readonly SymbolIdentityRow[]): readonly ImpactIdentityCandidate[] =>
  [...rows.map(toIdentityCandidate)]
    .sort((a, b) => {
      const aExport = a.scopeTier === 'exported' ? 0 : 1
      const bExport = b.scopeTier === 'exported' ? 0 : 1
      if (aExport !== bExport) {
        return aExport - bExport
      }
      if (a.qualifiedName === b.qualifiedName) {
        return a.symbolKey < b.symbolKey ? -1 : a.symbolKey > b.symbolKey ? 1 : 0
      }
      return a.qualifiedName < b.qualifiedName ? -1 : 1
    })
    .slice(0, AMBIGUITY_CANDIDATE_CAP)

export const unresolvedFromLocalNameMatches = (rows: readonly SymbolIdentityRow[]): ImpactIdentityResolution => {
  if (rows.length === 0) {
    return { status: 'unresolved', reason: 'unknown' }
  }
  return { status: 'unresolved', reason: 'ambiguous', candidates: rankAmbiguousCandidates(rows) }
}
