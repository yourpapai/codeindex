import type { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { repairReferences } from '../../src/indexer/repair-references.js'
import { openDatabase } from '../../src/storage/db.js'
import { ensureSchema } from '../../src/storage/schema.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  dirs.length = 0
})

const makeDb = (): Database => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-repair-'))
  dirs.push(dir)
  const db = openDatabase(path.join(dir, 'index.db'))
  ensureSchema(db)
  return db
}

interface SeedSymbolRow {
  readonly id: number
  readonly fileId: number
  readonly filePath: string
  readonly moduleKey: string
  readonly localName: string
  readonly kind?: string
}

interface SeedReferenceRow {
  readonly id: number
  readonly sourceSymbolId: number | null
  readonly sourceFileId: number
  readonly targetName: string
  readonly targetExportName?: string | null
  readonly targetModuleSpecifier?: string | null
  readonly edgeType: string
  readonly confidence: string
}

const seedGraph = (db: Database): void => {
  db.query(
    `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES (?, ?, ?, 'ts', 'hash', 'indexed', NULL, 0)`,
  ).run(11, 'src/a.ts', 'src/a')
  db.query(
    `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES (?, ?, ?, 'ts', 'hash', 'indexed', NULL, 0)`,
  ).run(12, 'src/b.ts', 'src/b')
  db.query(
    `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES (?, ?, ?, 'ts', 'hash', 'indexed', NULL, 0)`,
  ).run(13, 'src/c.ts', 'src/c')

  const insertSymbol = db.query(
    `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'exported', NULL, '[]', '', '', '', '', 1, 1)`,
  )
  const symbols: readonly SeedSymbolRow[] = [
    { id: 21, fileId: 11, filePath: 'src/a.ts', moduleKey: 'src/a', localName: 'caller' },
    { id: 22, fileId: 12, filePath: 'src/b.ts', moduleKey: 'src/b', localName: 'helper' },
    { id: 23, fileId: 13, filePath: 'src/c.ts', moduleKey: 'src/c', localName: 'helper' },
    { id: 24, fileId: 13, filePath: 'src/c.ts', moduleKey: 'src/c', localName: 'helper' },
    { id: 25, fileId: 12, filePath: 'src/b.ts', moduleKey: 'src/b', localName: 'unrelated' },
  ]
  for (const symbol of symbols) {
    insertSymbol.run(
      symbol.id,
      symbol.fileId,
      symbol.filePath,
      symbol.moduleKey,
      `${symbol.filePath}#${symbol.id}`,
      symbol.localName,
      `${symbol.moduleKey}#${symbol.localName}`,
      symbol.kind ?? 'function_declaration',
    )
  }
}

const seedSymbol = (db: Database, symbol: SeedSymbolRow): void => {
  db.query(
    `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'exported', NULL, '[]', '', '', '', '', 1, 1)`,
  ).run(
    symbol.id,
    symbol.fileId,
    symbol.filePath,
    symbol.moduleKey,
    `${symbol.filePath}#${symbol.id}`,
    symbol.localName,
    `${symbol.moduleKey}#${symbol.localName}`,
    symbol.kind ?? 'function_declaration',
  )
}

const seedReference = (db: Database, reference: SeedReferenceRow): void => {
  db.query(
    `INSERT INTO symbol_references (id, source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 3)`,
  ).run(
    reference.id,
    reference.sourceSymbolId,
    reference.sourceFileId,
    reference.targetName,
    reference.targetExportName ?? null,
    reference.targetModuleSpecifier ?? null,
    reference.edgeType,
    reference.confidence,
  )
}

interface ReferenceState {
  readonly target_symbol_id: number | null
  readonly target_file_id: number | null
  readonly confidence: string
}

const getReference = (db: Database, id: number): ReferenceState =>
  db
    .query<ReferenceState, [number]>(
      'SELECT target_symbol_id, target_file_id, confidence FROM symbol_references WHERE id = ?',
    )
    .get(id)!

describe('repairReferences', () => {
  test('orphaned edge with a unique scoped name re-links target symbol and file', () => {
    const db = makeDb()
    seedGraph(db)
    seedReference(db, {
      id: 31,
      sourceSymbolId: 21,
      sourceFileId: 11,
      targetName: 'helper',
      targetModuleSpecifier: './b',
      edgeType: 'calls',
      confidence: 'resolved',
    })

    const summary = repairReferences(db)

    expect(getReference(db, 31)).toEqual({ target_symbol_id: 22, target_file_id: 12, confidence: 'resolved' })
    expect(summary.referencesRepaired).toBe(1)
  })

  test('ambiguous local name in the scope module stays unbound', () => {
    const db = makeDb()
    seedGraph(db)
    seedReference(db, {
      id: 32,
      sourceSymbolId: 21,
      sourceFileId: 11,
      targetName: 'helper',
      targetModuleSpecifier: './c',
      edgeType: 'calls',
      confidence: 'file_resolved',
    })

    const summary = repairReferences(db)

    expect(getReference(db, 32)).toEqual({ target_symbol_id: null, target_file_id: null, confidence: 'file_resolved' })
    expect(summary.referencesRepaired).toBe(0)
  })

  test('specified-but-unmatched module resolves to nothing (no codebase-wide guessing)', () => {
    const db = makeDb()
    seedGraph(db)
    seedReference(db, {
      id: 33,
      sourceSymbolId: 21,
      sourceFileId: 11,
      targetName: 'unrelated',
      targetModuleSpecifier: './missing',
      edgeType: 'calls',
      confidence: 'name_only',
    })

    const summary = repairReferences(db)

    expect(getReference(db, 33)).toEqual({ target_symbol_id: null, target_file_id: null, confidence: 'name_only' })
    expect(summary.referencesRepaired).toBe(0)
  })

  test('stored confidence is preserved when a bare reference re-matches', () => {
    const db = makeDb()
    seedGraph(db)
    seedSymbol(db, { id: 26, fileId: 11, filePath: 'src/a.ts', moduleKey: 'src/a', localName: 'localUtility' })
    seedReference(db, {
      id: 34,
      sourceSymbolId: 21,
      sourceFileId: 11,
      targetName: 'localUtility',
      edgeType: 'calls',
      confidence: 'name_only',
    })

    const summary = repairReferences(db)

    expect(getReference(db, 34)).toEqual({ target_symbol_id: 26, target_file_id: null, confidence: 'name_only' })
    expect(summary.referencesRepaired).toBe(1)
  })

  test('never-resolved edge gets the same re-match chance', () => {
    const db = makeDb()
    seedGraph(db)
    seedReference(db, {
      id: 35,
      sourceSymbolId: 21,
      sourceFileId: 11,
      targetName: 'helper',
      targetExportName: 'helper',
      targetModuleSpecifier: './b',
      edgeType: 'imports',
      confidence: 'file_resolved',
    })

    const summary = repairReferences(db)

    expect(getReference(db, 35)).toEqual({ target_symbol_id: 22, target_file_id: 12, confidence: 'file_resolved' })
    expect(summary.referencesRepaired).toBe(1)
  })

  test('bare references edge (name-only class) is never re-bound', () => {
    const db = makeDb()
    seedGraph(db)
    seedSymbol(db, { id: 27, fileId: 11, filePath: 'src/a.ts', moduleKey: 'src/a', localName: 'shadowy' })
    seedReference(db, {
      id: 36,
      sourceSymbolId: 21,
      sourceFileId: 11,
      targetName: 'shadowy',
      edgeType: 'references',
      confidence: 'name_only',
    })

    const summary = repairReferences(db)

    expect(getReference(db, 36)).toEqual({ target_symbol_id: null, target_file_id: null, confidence: 'name_only' })
    expect(summary.referencesRepaired).toBe(0)
  })

  test('type_refs edge binds only a type-shaped symbol in the source module', () => {
    const db = makeDb()
    seedGraph(db)
    seedSymbol(db, {
      id: 28,
      fileId: 11,
      filePath: 'src/a.ts',
      moduleKey: 'src/a',
      localName: 'Task',
      kind: 'function_declaration',
    })
    seedSymbol(db, {
      id: 29,
      fileId: 11,
      filePath: 'src/a.ts',
      moduleKey: 'src/a',
      localName: 'Task',
      kind: 'interface_declaration',
    })
    seedReference(db, {
      id: 37,
      sourceSymbolId: 21,
      sourceFileId: 11,
      targetName: 'Task',
      edgeType: 'type_refs',
      confidence: 'name_only',
    })

    const summary = repairReferences(db)

    expect(getReference(db, 37)).toEqual({ target_symbol_id: 29, target_file_id: null, confidence: 'name_only' })
    expect(summary.referencesRepaired).toBe(1)
  })

  test('namespace import edge (targetExportName *) is never re-bound', () => {
    const db = makeDb()
    seedGraph(db)
    seedSymbol(db, { id: 30, fileId: 12, filePath: 'src/b.ts', moduleKey: 'src/b', localName: 'b' })
    seedReference(db, {
      id: 38,
      sourceSymbolId: null,
      sourceFileId: 11,
      targetName: 'b',
      targetExportName: '*',
      targetModuleSpecifier: './b',
      edgeType: 'imports',
      confidence: 'file_resolved',
    })

    const summary = repairReferences(db)

    expect(getReference(db, 38)).toEqual({ target_symbol_id: null, target_file_id: null, confidence: 'file_resolved' })
    expect(summary.referencesRepaired).toBe(0)
  })
})
