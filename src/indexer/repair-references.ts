import type { Database } from 'bun:sqlite'

import { normalizeRelativeModule } from '../resolver/resolve-references.js'
import { selectAllFiles, selectAllModuleAliases, selectAllSymbols } from '../storage/queries.js'

// Repair re-links reference edges whose target binding went NULL (FK ON DELETE SET NULL when a
// target file's symbols are delete+reinserted by a reindex) — or that never resolved. Orphaned and
// never-resolved rows are indistinguishable on disk, so the pass is an idempotent re-match of every
// NULL-target edge. It must never manufacture an edge a fresh full reindex would not produce, so it
// mirrors the resolver's tiers from stored rows: the last-resort local-name tier for ordinary edges,
// the type-shape filter for type_refs, and the resolver's refusals — C2 (specified-but-unmatched
// module resolves to nothing), B6 (bare value `references` edges never bind name-only), B5
// (namespace imports, targetExportName '*', never bind) — leave the edge unbound. Stored confidence
// describes the original resolution class and is left untouched.

const TYPE_SHAPED_KINDS: ReadonlySet<string> = new Set([
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'class_declaration',
  'abstract_class_declaration',
])

interface OrphanedReferenceRow {
  readonly id: number
  readonly source_file_id: number
  readonly target_name: string
  readonly target_export_name: string | null
  readonly target_module_specifier: string | null
  readonly edge_type: string
}

interface RepairContext {
  readonly symbols: ReturnType<typeof selectAllSymbols>
  readonly moduleKeyByFileId: ReadonlyMap<number, string>
  readonly fileIdByModuleKey: ReadonlyMap<string, number>
  readonly moduleAliases: ReturnType<typeof selectAllModuleAliases>
  readonly candidateIdsByModule: ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>
}

interface ScopeModule {
  readonly matchedFileId: number | null
  readonly scopeModuleKey: string
}

interface Rematch {
  readonly targetSymbolId: number | null
  readonly targetFileId: number | null
}

const buildRepairContext = (db: Database): RepairContext => {
  const symbols = selectAllSymbols(db)
  const files = selectAllFiles(db)
  const candidateIdsByModule = new Map<string, Map<string, number[]>>()
  for (const symbol of symbols) {
    let byName = candidateIdsByModule.get(symbol.moduleKey)
    if (byName === undefined) {
      byName = new Map<string, number[]>()
      candidateIdsByModule.set(symbol.moduleKey, byName)
    }
    const candidates = byName.get(symbol.localName)
    if (candidates === undefined) {
      byName.set(symbol.localName, [symbol.id])
    } else {
      candidates.push(symbol.id)
    }
  }
  return {
    symbols,
    moduleKeyByFileId: new Map(files.map((file) => [file.id, file.moduleKey])),
    fileIdByModuleKey: new Map(files.map((file) => [file.moduleKey, file.id])),
    moduleAliases: selectAllModuleAliases(db),
    candidateIdsByModule,
  }
}

// Derive the resolver's scope module exactly: a specifier goes through relative normalization, then
// module aliases, then the file table (re-establishing target_file_id); a specified-but-unmatched
// module resolves to NOTHING (C2 — no codebase-wide name guessing); a bare reference scopes to the
// source module. Returns null when the edge must stay unbound.
const deriveScopeModule = (
  sourceModuleKey: string,
  targetModuleSpecifier: string | null,
  context: RepairContext,
): ScopeModule | null => {
  if (targetModuleSpecifier === null) {
    return { matchedFileId: null, scopeModuleKey: sourceModuleKey }
  }
  const normalizedSpecifier = normalizeRelativeModule(sourceModuleKey, targetModuleSpecifier)
  const matchedFileId =
    context.moduleAliases.find((alias) => alias.aliasKey === normalizedSpecifier)?.fileId ??
    context.fileIdByModuleKey.get(normalizedSpecifier) ??
    null
  if (matchedFileId === null) {
    return null
  }
  const scopeModuleKey = context.moduleKeyByFileId.get(matchedFileId)
  if (scopeModuleKey === undefined) {
    return null
  }
  return { matchedFileId, scopeModuleKey }
}

// Type refs carry no specifier (resolveTypeReference refuses one) and bind only to a type-shaped
// symbol in the source module — the kind filter is the false-positive defense. Uniqueness applies:
// zero or multiple type-shaped candidates stay unbound.
const rematchTypeRef = (sourceModuleKey: string, targetName: string, context: RepairContext): number | null => {
  const typeShaped = context.symbols.filter(
    (symbol) =>
      symbol.localName === targetName && symbol.moduleKey === sourceModuleKey && TYPE_SHAPED_KINDS.has(symbol.kind),
  )
  return typeShaped.length === 1 ? typeShaped[0]!.id : null
}

const rematchRow = (row: OrphanedReferenceRow, context: RepairContext): Rematch => {
  const sourceModuleKey = context.moduleKeyByFileId.get(row.source_file_id)
  if (sourceModuleKey === undefined || row.target_export_name === '*') {
    return { targetSymbolId: null, targetFileId: null }
  }

  if (row.edge_type === 'type_refs') {
    if (row.target_module_specifier !== null) {
      return { targetSymbolId: null, targetFileId: null }
    }
    return { targetSymbolId: rematchTypeRef(sourceModuleKey, row.target_name, context), targetFileId: null }
  }

  const scope = deriveScopeModule(sourceModuleKey, row.target_module_specifier, context)
  if (scope === null) {
    return { targetSymbolId: null, targetFileId: null }
  }

  // B6: a bare value `references` edge resolvable only by same-module name is the shadowing-prone
  // class the resolver drops at insert — repair refuses it too.
  if (row.edge_type === 'references' && scope.matchedFileId === null) {
    return { targetSymbolId: null, targetFileId: null }
  }

  const byName = context.candidateIdsByModule.get(scope.scopeModuleKey)?.get(row.target_name)
  if (byName === undefined || byName.length !== 1) {
    return { targetSymbolId: null, targetFileId: null }
  }
  return { targetSymbolId: byName[0]!, targetFileId: scope.matchedFileId }
}

export const repairReferences = (db: Database): Readonly<{ referencesRepaired: number }> => {
  const orphaned = db
    .query<OrphanedReferenceRow, []>(
      `SELECT id, source_file_id, target_name, target_export_name, target_module_specifier, edge_type
       FROM symbol_references
       WHERE target_symbol_id IS NULL`,
    )
    .all()
  if (orphaned.length === 0) {
    return { referencesRepaired: 0 }
  }

  const context = buildRepairContext(db)
  const bindReference = db.query(
    'UPDATE symbol_references SET target_symbol_id = ?, target_file_id = ? WHERE id = ? AND target_symbol_id IS NULL',
  )

  let referencesRepaired = 0
  for (const row of orphaned) {
    const rematch = rematchRow(row, context)
    if (rematch.targetSymbolId === null) continue
    bindReference.run(rematch.targetSymbolId, rematch.targetFileId, row.id)
    referencesRepaired += 1
  }

  return { referencesRepaired }
}
