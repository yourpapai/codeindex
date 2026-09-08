import type { Database } from 'bun:sqlite'

import type { ExtractReferenceCandidatesResult } from '../indexer/extract-references.js'
import type { ExtractedSymbol } from '../indexer/extract-symbols.js'
import type { ModuleAlias } from '../resolver/module-specifiers.js'
import type { ExportKind } from '../types.js'

export const parseStringArray = (value: string): readonly string[] => {
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? parsed : []
}

export const clearFileRows = (db: Database, fileId: number): void => {
  db.query('DELETE FROM module_aliases WHERE file_id = ?').run(fileId)
  db.query('DELETE FROM module_exports WHERE file_id = ?').run(fileId)
  db.query('DELETE FROM symbol_references WHERE source_file_id = ?').run(fileId)
  db.query('DELETE FROM symbols WHERE file_id = ?').run(fileId)
}

export const pruneFilePaths = (db: Database, filePaths: readonly string[]): number => {
  let pruned = 0
  for (const filePath of filePaths) {
    db.query('DELETE FROM files WHERE file_path = ?').run(filePath)
    pruned += 1
  }
  return pruned
}

export const findDependentsOfDeletedFiles = (db: Database, prunablePaths: readonly string[]): ReadonlySet<string> => {
  const dependents = new Set<string>()

  for (const filePath of prunablePaths) {
    const rows = db
      .query<{ file_path: string }, [string]>(
        `SELECT DISTINCT source_files.file_path
         FROM symbol_references
         JOIN files AS source_files ON source_files.id = symbol_references.source_file_id
         JOIN files AS target_files ON target_files.file_path = ?
         LEFT JOIN symbols AS target_symbols ON target_symbols.id = symbol_references.target_symbol_id
         WHERE target_symbols.file_id = target_files.id
            OR symbol_references.target_file_id = target_files.id`,
      )
      .all(filePath)

    for (const row of rows) {
      dependents.add(row.file_path)
    }
  }

  return dependents
}

export const insertFile = (
  db: Database,
  values: Readonly<{ filePath: string; moduleKey: string; language: string; fileHash: string }>,
): number => {
  db.query(
    `INSERT INTO files (file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
       VALUES (?, ?, ?, ?, 'indexed', NULL, datetime('now'))
       ON CONFLICT(file_path) DO UPDATE SET
         module_key = excluded.module_key,
         language = excluded.language,
         file_hash = excluded.file_hash,
         parse_status = 'indexed',
         parse_error = NULL,
         indexed_at = datetime('now')`,
  ).run(values.filePath, values.moduleKey, values.language, values.fileHash)

  const row = db.query<{ id: number }, [string]>('SELECT id FROM files WHERE file_path = ?').get(values.filePath)
  if (row === null) {
    throw new Error(`Missing file row for ${values.filePath}`)
  }
  return row.id
}

export const markParseFailure = (db: Database, file: Readonly<{ relativePath: string }>, message: string): void => {
  const existing = db.query<{ id: number }, [string]>('SELECT id FROM files WHERE file_path = ?').get(file.relativePath)
  if (existing !== null) {
    clearFileRows(db, existing.id)
  }
  db.query(
    `INSERT INTO files (file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
       VALUES (?, ?, ?, '', 'parse_failed', ?, datetime('now'))
       ON CONFLICT(file_path) DO UPDATE SET parse_status = 'parse_failed', parse_error = excluded.parse_error, indexed_at = datetime('now')`,
  ).run(file.relativePath, file.relativePath.replace(/\.[^.]+$/, ''), 'ts', message)
}

export const backfillSymbolInDegree = (db: Database): void => {
  // The WHERE guard skips rows whose in_degree already matches, because SQLite fires UPDATE
  // triggers on every matched row even when the value is unchanged. Without it, a full-table
  // UPDATE would churn the symbols_au FTS sync trigger (a delete+reinsert per symbol) on every
  // run — including incremental runs, whose purpose is to avoid exactly that.
  db.run(
    'UPDATE symbols SET in_degree = (SELECT COUNT(*) FROM symbol_references WHERE symbol_references.target_symbol_id = symbols.id) WHERE in_degree <> (SELECT COUNT(*) FROM symbol_references WHERE symbol_references.target_symbol_id = symbols.id)',
  )
}

export const persistAliases = (db: Database, fileId: number, aliases: readonly ModuleAlias[]): void => {
  const stmt = db.query('INSERT INTO module_aliases (file_id, alias_key, alias_kind, precedence) VALUES (?, ?, ?, ?)')
  for (const alias of aliases) {
    stmt.run(fileId, alias.aliasKey, alias.aliasKind, alias.precedence)
  }
}

export const persistSymbols = (
  db: Database,
  fileId: number,
  filePath: string,
  moduleKey: string,
  symbols: readonly ExtractedSymbol[],
): number => {
  let count = 0
  const stmt = db.query(
    `INSERT INTO symbols (
        file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier,
        parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms,
        start_line, end_line
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const symbol of symbols) {
    stmt.run(
      fileId,
      filePath,
      moduleKey,
      symbol.symbolKey,
      symbol.localName,
      symbol.qualifiedName,
      symbol.kind,
      symbol.scopeTier,
      JSON.stringify(symbol.exportNames),
      symbol.signatureText,
      symbol.docText,
      symbol.bodyText,
      symbol.identifierTerms,
      symbol.startLine,
      symbol.endLine,
    )
    count += 1
  }

  linkParentSymbols(db, fileId, symbols)
  return count
}

const linkParentSymbols = (db: Database, fileId: number, symbols: readonly ExtractedSymbol[]): void => {
  const stmt = db.query<never, [string, number, string]>(
    `UPDATE symbols SET parent_symbol_id = (
       SELECT id FROM symbols WHERE qualified_name = ? AND file_id = ?
     ) WHERE symbol_key = ?`,
  )
  for (const symbol of symbols) {
    if (symbol.parentQualifiedName !== null) {
      stmt.run(symbol.parentQualifiedName, fileId, symbol.symbolKey)
    }
  }
}

export const selectStoredSymbols = (
  db: Database,
  fileId: number,
): readonly {
  id: number
  qualifiedName: string
  localName: string
  moduleKey: string
  exportNames: readonly string[]
}[] =>
  db
    .query<
      { id: number; qualified_name: string; local_name: string; module_key: string; export_names: string },
      [number]
    >('SELECT id, qualified_name, local_name, module_key, export_names FROM symbols WHERE file_id = ?')
    .all(fileId)
    .map((row) => ({
      id: row.id,
      qualifiedName: row.qualified_name,
      localName: row.local_name,
      moduleKey: row.module_key,
      exportNames: parseStringArray(row.export_names),
    }))

export const persistModuleExports = (
  db: Database,
  fileId: number,
  referenceCandidates: ExtractReferenceCandidatesResult,
  storedSymbols: ReturnType<typeof selectStoredSymbols>,
): void => {
  const stmt = db.query(
    'INSERT INTO module_exports (file_id, export_name, export_kind, symbol_id, target_module_specifier) VALUES (?, ?, ?, ?, ?)',
  )
  for (const moduleExport of referenceCandidates.moduleExports) {
    const matchingSymbol = storedSymbols.find((symbol) => symbol.localName === moduleExport.localName)
    stmt.run(
      fileId,
      moduleExport.exportName,
      moduleExport.exportKind,
      matchingSymbol?.id ?? null,
      moduleExport.targetModuleSpecifier,
    )
  }
}

type SymbolRow = {
  id: number
  qualifiedName: string
  localName: string
  moduleKey: string
  exportNames: string
  kind: string
}

export const selectAllSymbols = (
  db: Database,
): readonly {
  id: number
  qualifiedName: string
  localName: string
  moduleKey: string
  exportNames: readonly string[]
  kind: string
}[] =>
  db
    .query<SymbolRow, []>(
      'SELECT id, qualified_name AS qualifiedName, local_name AS localName, module_key AS moduleKey, export_names AS exportNames, kind FROM symbols',
    )
    .all()
    .map((row) => ({ ...row, exportNames: parseStringArray(row.exportNames) }))

export const selectAllFiles = (db: Database): readonly { id: number; moduleKey: string }[] =>
  db
    .query<{ id: number; module_key: string }, [string]>('SELECT id, module_key FROM files WHERE parse_status = ?')
    .all('indexed')
    .map((row) => ({ id: row.id, moduleKey: row.module_key }))

export const selectAllModuleAliases = (db: Database): readonly { aliasKey: string; fileId: number }[] =>
  db
    .query<{ alias_key: string; file_id: number }, []>('SELECT alias_key, file_id FROM module_aliases')
    .all()
    .map((row) => ({ aliasKey: row.alias_key, fileId: row.file_id }))

// Every module export, keyed by the exporting file's module key. A re-export (`export { x } from
// './y'`) stores symbol_id = NULL and target_module_specifier = './y'; a local export stores its
// symbol_id. The resolver walks these to bridge a caller's import of a name through a barrel to the
// real declaration (B4). Only parsed files participate.
export const selectAllModuleExports = (
  db: Database,
): readonly {
  moduleKey: string
  exportName: string
  exportKind: ExportKind
  symbolId: number | null
  targetModuleSpecifier: string | null
}[] =>
  db
    .query<
      {
        module_key: string
        export_name: string
        export_kind: ExportKind
        symbol_id: number | null
        target_module_specifier: string | null
      },
      []
    >(
      `SELECT f.module_key AS module_key, me.export_name AS export_name, me.export_kind AS export_kind,
              me.symbol_id AS symbol_id, me.target_module_specifier AS target_module_specifier
       FROM module_exports me JOIN files f ON f.id = me.file_id
       WHERE f.parse_status = 'indexed'`,
    )
    .all()
    .map((row) => ({
      moduleKey: row.module_key,
      exportName: row.export_name,
      exportKind: row.export_kind,
      symbolId: row.symbol_id,
      targetModuleSpecifier: row.target_module_specifier,
    }))
