import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'

import type { ExtractedSymbol } from '../../src/indexer/extract-symbols.js'
import {
  selectFileIdByPath,
  selectModuleExportsInFile,
  selectSymbolsInFile,
} from '../../src/storage/outline-queries.js'
import { persistSymbols } from '../../src/storage/queries.js'
import { ensureSchema } from '../../src/storage/schema.js'

const makeDb = (): Database => {
  const db = new Database(':memory:')
  db.run('PRAGMA foreign_keys = ON')
  ensureSchema(db)
  return db
}

const seedFile = (db: Database, filePath: string): number => {
  db.query(
    `INSERT INTO files (file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES (?, ?, 'ts', 'abc', 'indexed', NULL, ?)`,
  ).run(filePath, filePath.replace(/\.[^.]+$/, ''), Date.now())
  return db.query<{ id: number }, [string]>('SELECT id FROM files WHERE file_path = ?').get(filePath)!.id
}

const makeSymbol = (
  overrides: Partial<ExtractedSymbol> & Pick<ExtractedSymbol, 'symbolKey' | 'qualifiedName' | 'localName'>,
): ExtractedSymbol => ({
  kind: 'function_declaration',
  scopeTier: 'exported',
  exportNames: [],
  signatureText: '',
  docText: '',
  bodyText: '',
  identifierTerms: '',
  startLine: 1,
  endLine: 1,
  parentQualifiedName: null,
  ...overrides,
})

describe('selectFileIdByPath', () => {
  let db: Database

  beforeEach(() => {
    db = makeDb()
  })

  test('returns the file id for an exact indexed path', () => {
    const fileId = seedFile(db, 'src/mcp/tools.ts')
    expect(selectFileIdByPath(db, 'src/mcp/tools.ts')).toBe(fileId)
  })

  test('returns null for a missing or near-miss path', () => {
    seedFile(db, 'src/mcp/tools.ts')
    expect(selectFileIdByPath(db, 'src/mcp/tools')).toBeNull()
    expect(selectFileIdByPath(db, 'src/mcp/tools.tx')).toBeNull()
    expect(selectFileIdByPath(db, 'src/other/tools.ts')).toBeNull()
  })
})

describe('selectSymbolsInFile', () => {
  let db: Database

  beforeEach(() => {
    db = makeDb()
    const fileId = seedFile(db, 'src/dense.ts')
    persistSymbols(db, fileId, 'src/dense.ts', 'src/dense', [
      makeSymbol({
        symbolKey: 'src/dense.ts#10-20',
        qualifiedName: 'src/dense#localHelper',
        localName: 'localHelper',
        scopeTier: 'local',
        startLine: 10,
        endLine: 20,
        signatureText: 'function localHelper() {}',
      }),
      makeSymbol({
        symbolKey: 'src/dense.ts#5-50',
        qualifiedName: 'src/dense#Container',
        localName: 'Container',
        kind: 'class_declaration',
        scopeTier: 'module',
        startLine: 5,
        endLine: 50,
        signatureText: 'class Container {}',
      }),
      makeSymbol({
        symbolKey: 'src/dense.ts#8-12',
        qualifiedName: 'src/dense#Container>method',
        localName: 'method',
        kind: 'method_definition',
        scopeTier: 'member',
        startLine: 8,
        endLine: 12,
        signatureText: 'method(): void',
        parentQualifiedName: 'src/dense#Container',
      }),
      makeSymbol({
        symbolKey: 'src/dense.ts#1-3',
        qualifiedName: 'src/dense#exportedFn',
        localName: 'exportedFn',
        exportNames: ['exportedFn'],
        scopeTier: 'exported',
        startLine: 1,
        endLine: 3,
        signatureText: 'export function exportedFn() {}',
      }),
    ])
  })

  test('default excludes local scope and orders by start_line ascending', () => {
    const rows = selectSymbolsInFile(db, selectFileIdByPath(db, 'src/dense.ts')!)
    expect(rows.map((row) => row.localName)).toEqual(['exportedFn', 'Container', 'method'])
    expect(rows.every((row) => row.scopeTier !== 'local')).toBe(true)
  })

  test('returns compact structural columns without body or doc text', () => {
    const [row] = selectSymbolsInFile(db, selectFileIdByPath(db, 'src/dense.ts')!)
    expect(row).toBeDefined()
    expect(row!.symbolKey).toBe('src/dense.ts#1-3')
    expect(row!.qualifiedName).toBe('src/dense#exportedFn')
    expect(row!.signatureText).toBe('export function exportedFn() {}')
    expect(row!.exportNames).toEqual(['exportedFn'])
    expect(row!.startLine).toBe(1)
    expect(row!.endLine).toBe(3)
    expect(row).not.toHaveProperty('bodyText')
    expect(row).not.toHaveProperty('docText')
  })

  test('includes locals when scopeTiers requests them', () => {
    const rows = selectSymbolsInFile(db, selectFileIdByPath(db, 'src/dense.ts')!, {
      scopeTiers: ['exported', 'module', 'member', 'local'],
    })
    expect(rows.map((row) => row.localName)).toContain('localHelper')
  })

  test('filters by kinds when provided', () => {
    const rows = selectSymbolsInFile(db, selectFileIdByPath(db, 'src/dense.ts')!, {
      kinds: ['class_declaration'],
    })
    expect(rows.map((row) => row.localName)).toEqual(['Container'])
  })

  test('applies limit after ordering', () => {
    const rows = selectSymbolsInFile(db, selectFileIdByPath(db, 'src/dense.ts')!, { limit: 2 })
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.localName)).toEqual(['exportedFn', 'Container'])
  })
})

describe('selectModuleExportsInFile', () => {
  let db: Database
  let barrelFileId: number
  let localFileId: number

  beforeEach(() => {
    db = makeDb()
    barrelFileId = seedFile(db, 'src/index.ts')
    localFileId = seedFile(db, 'src/impl.ts')

    db.query(
      `INSERT INTO module_exports (file_id, export_name, export_kind, symbol_id, target_module_specifier)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(barrelFileId, 'helper', 'reexport', './helper')
    db.query(
      `INSERT INTO module_exports (file_id, export_name, export_kind, symbol_id, target_module_specifier)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(barrelFileId, '*', 'star', './impl')

    const symbolId = persistSymbols(db, localFileId, 'src/impl.ts', 'src/impl', [
      makeSymbol({
        symbolKey: 'src/impl.ts#1-2',
        qualifiedName: 'src/impl#realFn',
        localName: 'realFn',
        exportNames: ['realFn'],
        scopeTier: 'exported',
        signatureText: 'export function realFn() {}',
      }),
    ])
    // persistSymbols returns count, not id — re-query
    void symbolId
    const linked = db.query<{ id: number }, [string]>('SELECT id FROM symbols WHERE local_name = ?').get('realFn')!.id
    db.query(
      `INSERT INTO module_exports (file_id, export_name, export_kind, symbol_id, target_module_specifier)
       VALUES (?, ?, ?, ?, NULL)`,
    ).run(localFileId, 'realFn', 'named', linked)
  })

  test('returns pure-barrel re-exports with nullable symbol linkage', () => {
    const rows = selectModuleExportsInFile(db, barrelFileId)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.exportName).toBe('helper')
    expect(rows[0]!.exportKind).toBe('reexport')
    expect(rows[0]!.symbolId).toBeNull()
    expect(rows[0]!.qualifiedName).toBeNull()
    expect(rows[0]!.targetModuleSpecifier).toBe('./helper')
    expect(rows[1]!.exportName).toBe('*')
    expect(rows[1]!.exportKind).toBe('star')
    expect(rows[1]!.targetModuleSpecifier).toBe('./impl')
  })

  test('resolves qualifiedName when symbol_id is linked', () => {
    const rows = selectModuleExportsInFile(db, localFileId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.exportName).toBe('realFn')
    expect(rows[0]!.exportKind).toBe('named')
    expect(rows[0]!.symbolId).not.toBeNull()
    expect(rows[0]!.qualifiedName).toBe('src/impl#realFn')
    expect(rows[0]!.targetModuleSpecifier).toBeNull()
  })

  test('returns empty list for a file with no module_exports rows', () => {
    const emptyId = seedFile(db, 'src/empty.ts')
    expect(selectModuleExportsInFile(db, emptyId)).toEqual([])
  })

  test('applies limit', () => {
    expect(selectModuleExportsInFile(db, barrelFileId, { limit: 1 })).toHaveLength(1)
  })
})
