import type { Database } from 'bun:sqlite'

import {
  selectFileIdByPath,
  selectModuleExportsInFile,
  selectSymbolsInFile,
  type OutlineExportRow,
  type OutlineSymbolRow,
} from '../storage/outline-queries.js'
import type { ExportKind, ScopeTier } from '../types.js'

export type OutlineMode = 'symbols' | 'exports'

export type OutlineSymbol = Readonly<{
  symbolKey: string
  qualifiedName: string
  localName: string
  kind: string
  scopeTier: ScopeTier
  filePath: string
  startLine: number
  endLine: number
  signatureText: string
  exportNames: readonly string[]
}>

export type OutlineExport = Readonly<{
  exportName: string
  exportKind: ExportKind
  symbolId: number | null
  qualifiedName: string | null
  targetModuleSpecifier: string | null
  filePath: string
}>

export type OutlineSymbolOutcome = Readonly<{
  mode: 'symbols'
  filePath: string
  resultCount: number
  truncated: boolean
  results: readonly OutlineSymbol[]
  guidance?: string
}>

export type OutlineExportOutcome = Readonly<{
  mode: 'exports'
  filePath: string
  resultCount: number
  truncated: boolean
  results: readonly OutlineExport[]
  guidance?: string
}>

export type OutlineOutcome = OutlineSymbolOutcome | OutlineExportOutcome

const mapOutlineSymbolRow = (row: OutlineSymbolRow): OutlineSymbol => ({
  symbolKey: row.symbolKey,
  qualifiedName: row.qualifiedName,
  localName: row.localName,
  kind: row.kind,
  scopeTier: row.scopeTier,
  filePath: row.filePath,
  startLine: row.startLine,
  endLine: row.endLine,
  signatureText: row.signatureText,
  exportNames: row.exportNames,
})

const mapOutlineExportRow = (row: OutlineExportRow): OutlineExport => ({
  exportName: row.exportName,
  exportKind: row.exportKind,
  symbolId: row.symbolId,
  qualifiedName: row.qualifiedName,
  targetModuleSpecifier: row.targetModuleSpecifier,
  filePath: row.filePath,
})

const notIndexedGuidance = (filePath: string): string =>
  `Path "${filePath}" was not indexed. Use an exact repo-relative path (e.g. from code_search hits). Near-miss paths are never fuzzy-matched.`

const notIndexedOutcome = (filePath: string, mode: OutlineMode): OutlineOutcome => {
  const empty = {
    filePath,
    resultCount: 0,
    truncated: false,
    guidance: notIndexedGuidance(filePath),
    results: [] as const,
  }
  return mode === 'symbols' ? { mode: 'symbols', ...empty } : { mode: 'exports', ...empty }
}

const outlineSymbols = (
  db: Database,
  fileId: number,
  input: Readonly<{
    filePath: string
    limit: number
    scopeTiers?: readonly ScopeTier[]
    kinds?: readonly string[]
  }>,
): OutlineSymbolOutcome => {
  // limit+1 lets us detect truncation without a second COUNT query.
  const rows = selectSymbolsInFile(db, fileId, {
    scopeTiers: input.scopeTiers,
    kinds: input.kinds,
    limit: input.limit + 1,
  })
  return {
    mode: 'symbols',
    filePath: input.filePath,
    resultCount: Math.min(rows.length, input.limit),
    truncated: rows.length > input.limit,
    results: rows.slice(0, input.limit).map(mapOutlineSymbolRow),
  }
}

const outlineExports = (
  db: Database,
  fileId: number,
  input: Readonly<{ filePath: string; limit: number }>,
): OutlineExportOutcome => {
  const rows = selectModuleExportsInFile(db, fileId, { limit: input.limit + 1 })
  return {
    mode: 'exports',
    filePath: input.filePath,
    resultCount: Math.min(rows.length, input.limit),
    truncated: rows.length > input.limit,
    results: rows.slice(0, input.limit).map(mapOutlineExportRow),
  }
}

export const outlineFile = (
  db: Database,
  input: Readonly<{
    filePath: string
    mode: OutlineMode
    limit?: number
    scopeTiers?: readonly ScopeTier[]
    kinds?: readonly string[]
  }>,
): OutlineOutcome => {
  const limit = input.limit ?? 200
  const fileId = selectFileIdByPath(db, input.filePath)
  if (fileId === null) {
    return notIndexedOutcome(input.filePath, input.mode)
  }
  return input.mode === 'symbols'
    ? outlineSymbols(db, fileId, {
        filePath: input.filePath,
        limit,
        scopeTiers: input.scopeTiers,
        kinds: input.kinds,
      })
    : outlineExports(db, fileId, { filePath: input.filePath, limit })
}
