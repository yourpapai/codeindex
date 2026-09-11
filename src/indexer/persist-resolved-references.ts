import type { Database } from 'bun:sqlite'

import { resolveReferenceCandidates } from '../resolver/resolve-references.js'
import { selectAllFiles, selectAllModuleAliases, selectAllModuleExports, selectAllSymbols } from '../storage/queries.js'
import type { ExtractReferenceCandidatesResult } from './extract-references.js'

export interface ParsedFileWorkItem {
  readonly fileId: number
  readonly moduleKey: string
  readonly referenceCandidates: ExtractReferenceCandidatesResult
}

export const persistResolvedReferences = (
  db: Database,
  parsedFiles: readonly ParsedFileWorkItem[],
): Readonly<{ referencesIndexed: number; referencesUnresolved: number }> => {
  const allSymbols = selectAllSymbols(db)
  const allFiles = selectAllFiles(db)
  const allModuleAliases = selectAllModuleAliases(db)
  const allModuleExports = selectAllModuleExports(db)
  let referencesIndexed = 0
  let referencesUnresolved = 0
  const insertReference = db.query(
    'INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number, line_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )

  for (const parsedFile of parsedFiles) {
    const resolvedReferences = resolveReferenceCandidates({
      symbols: allSymbols,
      moduleAliases: allModuleAliases,
      files: allFiles,
      references: parsedFile.referenceCandidates.references,
      currentModuleKey: parsedFile.moduleKey,
      moduleExports: allModuleExports,
    })

    for (const reference of resolvedReferences) {
      insertReference.run(
        reference.sourceSymbolId,
        parsedFile.fileId,
        reference.targetSymbolId,
        reference.targetFileId,
        reference.targetName,
        reference.targetExportName,
        reference.targetModuleSpecifier,
        reference.edgeType,
        reference.confidence,
        reference.lineNumber,
        reference.lineText ?? '',
      )
      referencesIndexed += 1
      if (reference.targetSymbolId === null) {
        referencesUnresolved += 1
      }
    }
  }

  return { referencesIndexed, referencesUnresolved }
}
