import type { Database } from 'bun:sqlite'

import { normalizeRelativeModule } from '../src/resolver/resolve-references.js'
import { findIncomingReferences } from '../src/search/index.js'
import { selectAllFiles, selectAllModuleAliases } from '../src/storage/queries.js'

// Durability oracle for the edit fuzzer: after an N-edit sequence through incremental reindexes,
// the edge set and the code_impact results must equal a fresh full reindex's ground truth.
// Divergence is classified by which resolver tier produced the ground-truth binding:
// - tier1: repair can re-derive it from the stored row (specifier resolves to the target's module,
//   or a bare reference whose target lives in the source module) — divergence here is a bug and is
//   ASSERTED zero by the fuzz gate.
// - mapRouted: the ground truth bound a bare reference through the resolver's per-file import map,
//   which repair does not reconstruct — REPORTED for the tier-2 decision.
// - barrelRouted: the ground truth followed a re-export chain, so the specifier resolves to a
//   module other than the target's — REPORTED for the tier-2 decision.

export const countDanglingTargets = (db: Database): number => {
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM symbol_references
       WHERE target_symbol_id IS NOT NULL
         AND target_symbol_id NOT IN (SELECT id FROM symbols)`,
    )
    .get()
  return row === null ? 0 : row.n
}

export type EdgeTier = 'tier1' | 'mapRouted' | 'barrelRouted'

export interface ScopeTables {
  readonly moduleByAlias: ReadonlyMap<string, string>
  readonly moduleKeys: ReadonlySet<string>
}

export const loadScopeTables = (db: Database): ScopeTables => {
  const files = selectAllFiles(db)
  const moduleByFileId = new Map(files.map((file) => [file.id, file.moduleKey]))
  const moduleByAlias = new Map<string, string>()
  for (const alias of selectAllModuleAliases(db)) {
    const moduleKey = moduleByFileId.get(alias.fileId)
    if (moduleKey !== undefined) {
      moduleByAlias.set(alias.aliasKey, moduleKey)
    }
  }
  return { moduleByAlias, moduleKeys: new Set(files.map((file) => file.moduleKey)) }
}

export interface OracleEdge {
  readonly key: string
  readonly resolved: boolean
  readonly confidence: string
  readonly sourceQualifiedName: string | null
  readonly sourceFilePath: string
  readonly sourceModule: string | null
  readonly targetQualifiedName: string | null
  readonly targetModule: string | null
  readonly specifier: string | null
  readonly edgeType: string
  readonly lineNumber: number
}

const edgeKey = (
  row: Readonly<{
    source_qualified_name: string | null
    target_name: string
    specifier: string | null
    edge_type: string
    line_number: number
  }>,
): string =>
  `${row.source_qualified_name ?? ''}|${row.target_name}|${row.specifier ?? ''}|${row.edge_type}|${row.line_number}`

export const loadOracleEdges = (db: Database): readonly OracleEdge[] =>
  db
    .query<
      {
        source_qualified_name: string | null
        source_file_path: string
        source_module: string
        target_name: string
        specifier: string | null
        edge_type: string
        line_number: number
        confidence: string
        target_symbol_id: number | null
        target_qualified_name: string | null
        target_module: string | null
      },
      []
    >(
      `SELECT s.qualified_name AS source_qualified_name, sf.file_path AS source_file_path,
              sf.module_key AS source_module, r.target_name, r.target_module_specifier AS specifier,
              r.edge_type, r.line_number, r.confidence, r.target_symbol_id,
              ts.qualified_name AS target_qualified_name, tf.module_key AS target_module
       FROM symbol_references r
       JOIN files sf ON sf.id = r.source_file_id
       LEFT JOIN symbols s ON s.id = r.source_symbol_id
       LEFT JOIN symbols ts ON ts.id = r.target_symbol_id
       LEFT JOIN files tf ON tf.id = ts.file_id`,
    )
    .all()
    .map((row) => ({
      key: edgeKey(row),
      resolved: row.target_symbol_id !== null,
      confidence: row.confidence,
      sourceQualifiedName: row.source_qualified_name,
      sourceFilePath: row.source_file_path,
      sourceModule: row.source_module,
      targetQualifiedName: row.target_qualified_name,
      targetModule: row.target_module,
      specifier: row.specifier,
      edgeType: row.edge_type,
      lineNumber: row.line_number,
    }))

export const classifyEdge = (
  sourceModule: string,
  targetModule: string,
  specifier: string | null,
  tables: ScopeTables,
): EdgeTier => {
  if (specifier === null) {
    return targetModule === sourceModule ? 'tier1' : 'mapRouted'
  }
  const normalized = normalizeRelativeModule(sourceModule, specifier)
  const specifierModule =
    tables.moduleByAlias.get(normalized) ?? (tables.moduleKeys.has(normalized) ? normalized : null)
  return specifierModule === targetModule ? 'tier1' : 'barrelRouted'
}

export interface EdgeDivergence {
  readonly checked: number
  readonly orphaned: number
  readonly missingEdges: number
  readonly extraEdges: number
  readonly falseResolved: number
  readonly unexpectedUnresolved: number
  readonly mapRoutedDivergence: number
  readonly barrelRoutedDivergence: number
}

export const compareEdges = (incDb: Database, fullDb: Database, tables: ScopeTables): EdgeDivergence => {
  const incEdges = new Map(loadOracleEdges(incDb).map((edge) => [edge.key, edge]))
  const fullEdges = loadOracleEdges(fullDb)
  const accumulate = (divergence: EdgeDivergence, edge: OracleEdge, inc: OracleEdge | undefined): EdgeDivergence => {
    if (inc === undefined) {
      return { ...divergence, missingEdges: divergence.missingEdges + 1 }
    }
    if (edge.resolved && !inc.resolved) {
      const tier = classifyEdge(edge.sourceModule ?? '', edge.targetModule ?? '', edge.specifier, tables)
      if (tier === 'tier1') {
        return {
          ...divergence,
          orphaned: divergence.orphaned + 1,
          unexpectedUnresolved: divergence.unexpectedUnresolved + 1,
        }
      }
      if (tier === 'mapRouted') {
        return {
          ...divergence,
          orphaned: divergence.orphaned + 1,
          mapRoutedDivergence: divergence.mapRoutedDivergence + 1,
        }
      }
      return {
        ...divergence,
        orphaned: divergence.orphaned + 1,
        barrelRoutedDivergence: divergence.barrelRoutedDivergence + 1,
      }
    }
    if (!edge.resolved && inc.resolved) {
      return { ...divergence, falseResolved: divergence.falseResolved + 1 }
    }
    return divergence
  }
  let checked = 0
  let divergence: EdgeDivergence = {
    checked: 0,
    orphaned: 0,
    missingEdges: 0,
    extraEdges: 0,
    falseResolved: 0,
    unexpectedUnresolved: 0,
    mapRoutedDivergence: 0,
    barrelRoutedDivergence: 0,
  }
  for (const edge of fullEdges) {
    if (edge.resolved) {
      checked += 1
    }
    divergence = accumulate(divergence, edge, incEdges.get(edge.key))
  }
  const fullKeys = new Set(fullEdges.map((edge) => edge.key))
  let extraEdges = 0
  for (const key of incEdges.keys()) {
    if (!fullKeys.has(key)) {
      extraEdges += 1
    }
  }
  return { ...divergence, checked, extraEdges }
}

const impactSignature = (
  row: Readonly<{
    sourceQualifiedName: string | null
    sourceFilePath: string
    edgeType: string
    confidence: string
    lineNumber: number
  }>,
): string =>
  `${row.sourceQualifiedName ?? ''}|${row.sourceFilePath}|${row.edgeType}|${row.confidence}|${row.lineNumber}`

const countBy = <T>(rows: readonly T[], signature: (row: T) => string): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = signature(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export interface ImpactDivergence {
  readonly unexpectedImpactDivergence: number
  readonly mapRoutedImpactDivergence: number
  readonly barrelRoutedImpactDivergence: number
}

const indexGroundTruthEdges = (fullDb: Database): Map<string, Map<string, OracleEdge>> => {
  const edgesByTarget = new Map<string, Map<string, OracleEdge>>()
  for (const edge of loadOracleEdges(fullDb)) {
    if (edge.targetQualifiedName === null || !edge.resolved) {
      continue
    }
    let bySignature = edgesByTarget.get(edge.targetQualifiedName)
    if (bySignature === undefined) {
      bySignature = new Map<string, OracleEdge>()
      edgesByTarget.set(edge.targetQualifiedName, bySignature)
    }
    bySignature.set(impactSignature(edge), edge)
  }
  return edgesByTarget
}

const addMissing = (divergence: ImpactDivergence, tier: EdgeTier, amount: number): ImpactDivergence => {
  if (tier === 'mapRouted') {
    return { ...divergence, mapRoutedImpactDivergence: divergence.mapRoutedImpactDivergence + amount }
  }
  if (tier === 'barrelRouted') {
    return { ...divergence, barrelRoutedImpactDivergence: divergence.barrelRoutedImpactDivergence + amount }
  }
  return { ...divergence, unexpectedImpactDivergence: divergence.unexpectedImpactDivergence + amount }
}

const classifyMissingRow = (edge: OracleEdge | undefined, tables: ScopeTables): EdgeTier => {
  if (edge === undefined) {
    return 'tier1'
  }
  return classifyEdge(edge.sourceModule ?? '', edge.targetModule ?? '', edge.specifier, tables)
}

const ZERO_IMPACT_DIVERGENCE: ImpactDivergence = {
  unexpectedImpactDivergence: 0,
  mapRoutedImpactDivergence: 0,
  barrelRoutedImpactDivergence: 0,
}

// code_impact equality: for every target symbol, the incoming-reference rows from the incremental
// DB must equal the ground truth's as a multiset. A missing tier-1 row (or any surplus row) is a
// violation; missing routed-class rows are the reported tier-2 signal.
export const compareImpact = (incDb: Database, fullDb: Database, tables: ScopeTables): ImpactDivergence => {
  const edgesByTarget = indexGroundTruthEdges(fullDb)
  let divergence: ImpactDivergence = ZERO_IMPACT_DIVERGENCE
  const targets = fullDb.query<{ qualified_name: string }, []>('SELECT qualified_name FROM symbols').all()
  for (const target of targets) {
    const fullRows = countBy(
      findIncomingReferences(fullDb, { qualifiedName: target.qualified_name, limit: 500 }),
      impactSignature,
    )
    const incRows = countBy(
      findIncomingReferences(incDb, { qualifiedName: target.qualified_name, limit: 500 }),
      impactSignature,
    )
    const edgeSignatures = edgesByTarget.get(target.qualified_name)
    for (const [signature, count] of fullRows) {
      const missing = count - (incRows.get(signature) ?? 0)
      if (missing > 0) {
        divergence = addMissing(divergence, classifyMissingRow(edgeSignatures?.get(signature), tables), missing)
      }
    }
    for (const [signature, count] of incRows) {
      const surplus = count - (fullRows.get(signature) ?? 0)
      if (surplus > 0) {
        divergence = { ...divergence, unexpectedImpactDivergence: divergence.unexpectedImpactDivergence + surplus }
      }
    }
  }
  return divergence
}
