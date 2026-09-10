import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { findIncomingReferences, findSymbolCandidates, resolveIncomingReferences } from '../src/impact.js'
import { ensureSchema } from '../src/storage/schema.js'

describe('symbol resolution and impact', () => {
  test('returns symbol candidates and module-level importers', () => {
    const db = new Database(':memory:')
    ensureSchema(db)

    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/helper.ts', 'src/helper', 'ts', 'x', 'indexed', NULL, datetime('now'))`,
    ).run()
    db.query(
      `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line) VALUES (1, 1, 'src/helper.ts', 'src/helper', 'src/helper.ts#0-20', 'helper', 'src/helper#helper', 'function_declaration', 'exported', NULL, '["helper"]', 'export function helper()', '', 'export function helper() {}', 'helper', 1, 1)`,
    ).run()
    db.query(
      `INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number) VALUES (NULL, 1, 1, 'helper', 'helper', './helper', 'imports', 'resolved', 1)`,
    ).run()

    expect(findSymbolCandidates(db, 'helper', 5)[0]?.qualifiedName).toBe('src/helper#helper')
    expect(findIncomingReferences(db, { qualifiedName: 'src/helper#helper', limit: 10 })[0]?.edgeType).toBe('imports')
  })
})

interface SeedSymbolInput {
  readonly id: number
  readonly fileId: number
  readonly filePath: string
  readonly moduleKey: string
  readonly symbolKey: string
  readonly localName: string
  readonly qualifiedName: string
  readonly scopeTier: 'exported' | 'module'
}

const seedFile = (db: Database, id: number, filePath: string, moduleKey: string): void => {
  db.query(
    `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at)
     VALUES (?, ?, ?, 'ts', 'x', 'indexed', NULL, datetime('now'))`,
  ).run(id, filePath, moduleKey)
}

const seedSymbol = (db: Database, symbol: SeedSymbolInput): void => {
  db.query(
    `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'function_declaration', ?, NULL, ?, ?, '', ?, ?, 1, 1)`,
  ).run(
    symbol.id,
    symbol.fileId,
    symbol.filePath,
    symbol.moduleKey,
    symbol.symbolKey,
    symbol.localName,
    symbol.qualifiedName,
    symbol.scopeTier,
    JSON.stringify([symbol.localName]),
    `export function ${symbol.localName}()`,
    `export function ${symbol.localName}() {}`,
    symbol.localName.toLowerCase(),
  )
}

const seedReference = (db: Database, sourceSymbolId: number, sourceFileId: number, targetSymbolId: number): void => {
  db.query(
    `INSERT INTO symbol_references (source_symbol_id, source_file_id, target_symbol_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number)
     VALUES (?, ?, ?, ?, ?, ?, 'calls', 'resolved', 5)`,
  ).run(sourceSymbolId, sourceFileId, targetSymbolId, 'openDatabase', 'openDatabase', './db')
}

// Mirrors the live-trap fixture from the proposal: `openDatabase` in src/storage/db.ts
// with one resolved incoming edge from src/mcp/session.ts.
const seedOpenDatabaseFixture = (db: Database): void => {
  seedFile(db, 1, 'src/storage/db.ts', 'src/storage/db')
  seedFile(db, 2, 'src/mcp/session.ts', 'src/mcp/session')
  seedSymbol(db, {
    id: 1,
    fileId: 1,
    filePath: 'src/storage/db.ts',
    moduleKey: 'src/storage/db',
    symbolKey: 'src/storage/db.ts#120-190',
    localName: 'openDatabase',
    qualifiedName: 'src/storage/db#openDatabase',
    scopeTier: 'exported',
  })
  seedSymbol(db, {
    id: 2,
    fileId: 2,
    filePath: 'src/mcp/session.ts',
    moduleKey: 'src/mcp/session',
    symbolKey: 'src/mcp/session.ts#10-40',
    localName: 'openSession',
    qualifiedName: 'src/mcp/session#openSession',
    scopeTier: 'module',
  })
  seedReference(db, 2, 2, 1)
}

describe('resolveIncomingReferences', () => {
  test('canonical symbol_key resolves with rows identical to findIncomingReferences', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    const input = { symbolKey: 'src/storage/db.ts#120-190', limit: 10 }
    expect(resolveIncomingReferences(db, input)).toEqual({
      resolution: {
        status: 'canonical',
        matchedBy: 'symbol_key',
        symbolKey: 'src/storage/db.ts#120-190',
        qualifiedName: 'src/storage/db#openDatabase',
      },
      results: findIncomingReferences(db, input),
    })
  })

  test('canonical qualified_name resolves', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    expect(resolveIncomingReferences(db, { qualifiedName: 'src/storage/db#openDatabase', limit: 10 })).toEqual({
      resolution: {
        status: 'canonical',
        matchedBy: 'qualified_name',
        symbolKey: 'src/storage/db.ts#120-190',
        qualifiedName: 'src/storage/db#openDatabase',
      },
      results: findIncomingReferences(db, { qualifiedName: 'src/storage/db#openDatabase', limit: 10 }),
    })
  })

  test('qualified-name form sent as symbolKey resolves via qualified_name', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    expect(resolveIncomingReferences(db, { symbolKey: 'src/storage/db#openDatabase', limit: 10 })).toEqual({
      resolution: {
        status: 'resolved',
        matchedBy: 'qualified_name',
        symbolKey: 'src/storage/db.ts#120-190',
        qualifiedName: 'src/storage/db#openDatabase',
      },
      results: findIncomingReferences(db, { qualifiedName: 'src/storage/db#openDatabase', limit: 10 }),
    })
  })

  test('bare local name sent as qualifiedName resolves via local_name', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    expect(resolveIncomingReferences(db, { qualifiedName: 'openDatabase', limit: 10 })).toEqual({
      resolution: {
        status: 'resolved',
        matchedBy: 'local_name',
        symbolKey: 'src/storage/db.ts#120-190',
        qualifiedName: 'src/storage/db#openDatabase',
      },
      results: findIncomingReferences(db, { qualifiedName: 'src/storage/db#openDatabase', limit: 10 }),
    })
  })

  test('shared local name resolves to the rank-first candidate and echoes identity', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedFile(db, 1, 'src/a.ts', 'src/a')
    seedFile(db, 2, 'src/b.ts', 'src/b')
    seedSymbol(db, {
      id: 3,
      fileId: 1,
      filePath: 'src/a.ts',
      moduleKey: 'src/a',
      symbolKey: 'src/a.ts#0-9',
      localName: 'dup',
      qualifiedName: 'src/a#dup',
      scopeTier: 'module',
    })
    seedSymbol(db, {
      id: 4,
      fileId: 2,
      filePath: 'src/b.ts',
      moduleKey: 'src/b',
      symbolKey: 'src/b.ts#0-9',
      localName: 'dup',
      qualifiedName: 'src/b#dup',
      scopeTier: 'exported',
    })

    expect(resolveIncomingReferences(db, { qualifiedName: 'dup', limit: 10 })).toEqual({
      resolution: {
        status: 'resolved',
        matchedBy: 'local_name',
        symbolKey: 'src/b.ts#0-9',
        qualifiedName: 'src/b#dup',
      },
      results: [],
    })
  })

  test('unknown identity is unresolved with no rows', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    expect(resolveIncomingReferences(db, { qualifiedName: 'doesNotExist', limit: 10 })).toEqual({
      resolution: { status: 'unresolved' },
      results: [],
    })
  })

  test('identity resolution does not fall back to fuzzy or path-prefix matches', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    // 'src/storage/db' prefix-matches the file path in the exact stage and would also hit
    // FTS, but it is not an exact symbol_key/qualified_name/local_name — so it must stay unresolved.
    expect(resolveIncomingReferences(db, { qualifiedName: 'src/storage/db', limit: 10 })).toEqual({
      resolution: { status: 'unresolved' },
      results: [],
    })
  })

  test('findIncomingReferences keeps returning empty rows on a miss', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedOpenDatabaseFixture(db)

    expect(findIncomingReferences(db, { symbolKey: 'src/storage/db#openDatabase', limit: 10 })).toEqual([])
    expect(findIncomingReferences(db, { qualifiedName: 'openDatabase', limit: 10 })).toEqual([])
  })
})
