import type { Database } from 'bun:sqlite'

import type { ExportKind, ScopeTier } from '../types.js'
import { parseStringArray } from './queries.js'

// Outline (code_outline) read path: exact file identity, compact structural rows, no ranking.
export type OutlineSymbolRow = Readonly<{
  id: number
  localName: string
  qualifiedName: string
  kind: string
  scopeTier: ScopeTier
  filePath: string
  startLine: number
  endLine: number
  symbolKey: string
  signatureText: string
  exportNames: readonly string[]
}>

export type OutlineExportRow = Readonly<{
  id: number
  exportName: string
  exportKind: ExportKind
  symbolId: number | null
  qualifiedName: string | null
  targetModuleSpecifier: string | null
  filePath: string
}>

const DEFAULT_OUTLINE_SCOPE_TIERS: readonly ScopeTier[] = ['exported', 'module', 'member']

const OUTLINE_SYMBOL_COLUMNS = `id, local_name, qualified_name, kind, scope_tier, file_path, start_line, end_line,
        symbol_key, signature_text, export_names`

type OutlineSymbolSqlRow = {
  id: number
  local_name: string
  qualified_name: string
  kind: string
  scope_tier: ScopeTier
  file_path: string
  start_line: number
  end_line: number
  symbol_key: string
  signature_text: string
  export_names: string
}

const mapOutlineSymbolRow = (row: OutlineSymbolSqlRow): OutlineSymbolRow => ({
  id: row.id,
  localName: row.local_name,
  qualifiedName: row.qualified_name,
  kind: row.kind,
  scopeTier: row.scope_tier,
  filePath: row.file_path,
  startLine: row.start_line,
  endLine: row.end_line,
  symbolKey: row.symbol_key,
  signatureText: row.signature_text,
  exportNames: parseStringArray(row.export_names),
})

export const selectFileIdByPath = (db: Database, filePath: string): number | null =>
  db.query<{ id: number }, [string]>('SELECT id FROM files WHERE file_path = ?').get(filePath)?.id ?? null

export const selectSymbolsInFile = (
  db: Database,
  fileId: number,
  options: Readonly<{
    scopeTiers?: readonly ScopeTier[]
    kinds?: readonly string[]
    limit?: number
  }> = {},
): readonly OutlineSymbolRow[] => {
  const scopeTiers = options.scopeTiers ?? DEFAULT_OUTLINE_SCOPE_TIERS
  const kinds = options.kinds ?? []
  const limit = options.limit ?? 500
  if (scopeTiers.length === 0) {
    return []
  }

  const tierPlaceholders = scopeTiers.map(() => '?').join(', ')
  const kindClause = kinds.length === 0 ? '' : ` AND kind IN (${kinds.map(() => '?').join(', ')})`
  const params: (number | string)[] = [fileId, ...scopeTiers, ...kinds, limit]

  return db
    .query<OutlineSymbolSqlRow, typeof params>(
      `SELECT ${OUTLINE_SYMBOL_COLUMNS}
       FROM symbols
       WHERE file_id = ?
         AND scope_tier IN (${tierPlaceholders})${kindClause}
       ORDER BY start_line ASC, id ASC
       LIMIT ?`,
    )
    .all(...params)
    .map(mapOutlineSymbolRow)
}

export const selectModuleExportsInFile = (
  db: Database,
  fileId: number,
  options: Readonly<{ limit?: number }> = {},
): readonly OutlineExportRow[] => {
  const limit = options.limit ?? 500
  return db
    .query<
      {
        id: number
        export_name: string
        export_kind: ExportKind
        symbol_id: number | null
        qualified_name: string | null
        target_module_specifier: string | null
        file_path: string
      },
      [number, number]
    >(
      `SELECT me.id,
              me.export_name,
              me.export_kind,
              me.symbol_id,
              s.qualified_name AS qualified_name,
              me.target_module_specifier,
              f.file_path
       FROM module_exports me
       JOIN files f ON f.id = me.file_id
       LEFT JOIN symbols s ON s.id = me.symbol_id
       WHERE me.file_id = ?
       ORDER BY me.id ASC
       LIMIT ?`,
    )
    .all(fileId, limit)
    .map((row) => ({
      id: row.id,
      exportName: row.export_name,
      exportKind: row.export_kind,
      symbolId: row.symbol_id,
      qualifiedName: row.qualified_name,
      targetModuleSpecifier: row.target_module_specifier,
      filePath: row.file_path,
    }))
}
