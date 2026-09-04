import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import type { ExtractedSymbol } from '../../src/indexer/extract-symbols.js'
import {
  backfillSymbolInDegree,
  findDependentsOfDeletedFiles,
  markParseFailure,
  persistSymbols,
  pruneDeletedFiles,
  selectAllModuleExports,
} from '../../src/storage/queries.js'
import { ensureSchema } from '../../src/storage/schema.js'

const seedFiles = (db: Database, paths: readonly string[]): void => {
  for (const filePath of paths) {
    db.query(
      `INSERT INTO files (file_path, module_key, language, file_hash, parse_status, indexed_at)
       VALUES (?, ?, 'ts', 'abc', 'indexed', datetime('now'))`,
    ).run(filePath, filePath.replace(/\.[^.]+$/, ''))
  }
}

const makeSymbol = (
  overrides: Partial<ExtractedSymbol> & Pick<ExtractedSymbol, 'symbolKey' | 'qualifiedName'>,
): ExtractedSymbol => ({
  localName: 'name',
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

describe('persistSymbols', () => {
  test('sets parent_symbol_id for nested symbols', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    ensureSchema(db)
    seedFiles(db, ['src/a.ts'])
    const fileId = db.query<{ id: number }, []>('SELECT id FROM files').get()!.id

    const parent = makeSymbol({ symbolKey: 'src/a.ts#0-50', qualifiedName: 'src/a#Parent', localName: 'Parent' })
    const child = makeSymbol({
      symbolKey: 'src/a.ts#10-40',
      qualifiedName: 'src/a#Parent>method',
      localName: 'method',
      scopeTier: 'member',
      parentQualifiedName: 'src/a#Parent',
    })

    persistSymbols(db, fileId, 'src/a.ts', 'src/a', [parent, child])

    const parentRow = db
      .query<{ id: number }, [string]>('SELECT id FROM symbols WHERE symbol_key = ?')
      .get(parent.symbolKey)!
    const childRow = db
      .query<{ parent_symbol_id: number | null }, [string]>('SELECT parent_symbol_id FROM symbols WHERE symbol_key = ?')
      .get(child.symbolKey)!

    expect(childRow.parent_symbol_id).toBe(parentRow.id)
  })

  test('leaves parent_symbol_id NULL for top-level symbols', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    ensureSchema(db)
    seedFiles(db, ['src/b.ts'])
    const fileId = db.query<{ id: number }, []>('SELECT id FROM files').get()!.id

    const symbol = makeSymbol({ symbolKey: 'src/b.ts#0-20', qualifiedName: 'src/b#Foo', localName: 'Foo' })
    persistSymbols(db, fileId, 'src/b.ts', 'src/b', [symbol])

    const row = db
      .query<{ parent_symbol_id: number | null }, [string]>('SELECT parent_symbol_id FROM symbols WHERE symbol_key = ?')
      .get(symbol.symbolKey)!
    expect(row.parent_symbol_id).toBeNull()
  })
})

describe('findDependentsOfDeletedFiles', () => {
  test('includes callers whose reference has target_file_id set but target_symbol_id null', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    ensureSchema(db)
    seedFiles(db, ['src/helper.ts', 'src/main.ts'])

    const helperId = db
      .query<{ id: number }, [string]>('SELECT id FROM files WHERE file_path = ?')
      .get('src/helper.ts')!.id
    const mainId = db.query<{ id: number }, [string]>('SELECT id FROM files WHERE file_path = ?').get('src/main.ts')!.id

    db.query(
      `INSERT INTO symbol_references
         (source_file_id, target_symbol_id, target_file_id, target_name, edge_type, confidence, line_number)
       VALUES (?, NULL, ?, 'myFunc', 'imports', 'file_resolved', 1)`,
    ).run(mainId, helperId)

    const dependents = findDependentsOfDeletedFiles(db, new Set(['src/main.ts']))

    expect(dependents).toContain('src/main.ts')
  })
})

describe('markParseFailure', () => {
  test('clears stale symbols and aliases when a previously indexed file fails to parse', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    ensureSchema(db)
    seedFiles(db, ['src/a.ts'])
    const fileId = db.query<{ id: number }, []>('SELECT id FROM files').get()!.id

    persistSymbols(db, fileId, 'src/a.ts', 'src/a', [
      makeSymbol({ symbolKey: 'src/a.ts#0-10', qualifiedName: 'src/a#Foo', localName: 'Foo' }),
    ])
    db.query('INSERT INTO module_aliases (file_id, alias_key, alias_kind, precedence) VALUES (?, ?, ?, ?)').run(
      fileId,
      'src/a',
      'module_key',
      0,
    )

    markParseFailure(db, { relativePath: 'src/a.ts' }, 'syntax error')

    const symbols = db.query<{ id: number }, []>('SELECT id FROM symbols').all()
    const aliases = db.query<{ id: number }, []>('SELECT id FROM module_aliases').all()
    const file = db.query<{ parse_status: string }, []>('SELECT parse_status FROM files').get()!

    expect(symbols).toHaveLength(0)
    expect(aliases).toHaveLength(0)
    expect(file.parse_status).toBe('parse_failed')
  })

  test('creates a new file row with parse_failed status for a file that was never indexed', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    ensureSchema(db)

    markParseFailure(db, { relativePath: 'src/new.ts' }, 'parse error')

    const file = db
      .query<{ parse_status: string; parse_error: string }, []>('SELECT parse_status, parse_error FROM files')
      .get()!
    expect(file.parse_status).toBe('parse_failed')
    expect(file.parse_error).toBe('parse error')
  })
})

describe('pruneDeletedFiles', () => {
  test('removes rows whose paths are absent from the discovered set', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    ensureSchema(db)
    seedFiles(db, ['src/a.ts', 'src/b.ts', 'src/c.ts'])

    const pruned = pruneDeletedFiles(db, new Set(['src/a.ts', 'src/c.ts']))

    expect(pruned).toBe(1)
    const remaining = db
      .query<{ file_path: string }, []>('SELECT file_path FROM files')
      .all()
      .map((r) => r.file_path)
    expect(remaining).toEqual(['src/a.ts', 'src/c.ts'])
  })

  test('returns 0 when all stored files are still present', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    ensureSchema(db)
    seedFiles(db, ['src/a.ts'])

    const pruned = pruneDeletedFiles(db, new Set(['src/a.ts']))

    expect(pruned).toBe(0)
  })

  test('removes all rows when discovered set is empty', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    ensureSchema(db)
    seedFiles(db, ['src/a.ts', 'src/b.ts'])

    const pruned = pruneDeletedFiles(db, new Set())

    expect(pruned).toBe(2)
    const remaining = db.query<{ file_path: string }, []>('SELECT file_path FROM files').all()
    expect(remaining).toHaveLength(0)
  })
})

describe('backfillSymbolInDegree', () => {
  test('counts incoming references per symbol', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    ensureSchema(db)
    seedFiles(db, ['src/a.ts'])
    const fileId = db.query<{ id: number }, []>('SELECT id FROM files').get()!.id

    const insertSymbol = db.query(
      `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
       VALUES (?, ?, 'src/a.ts', 'src/a', ?, ?, ?, 'function_declaration', 'exported', NULL, '[]', '', '', '', 'x', 1, 2)`,
    )
    for (const id of [1, 2, 3]) {
      insertSymbol.run(id, fileId, `src/a.ts#${id}-2`, `s${id}`, `src/a#s${id}`)
    }
    const insertRef = db.query(
      `INSERT INTO symbol_references (id, source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number)
       VALUES (?, ?, ?, ?, NULL, 'x', NULL, NULL, 'calls', 'resolved', 5)`,
    )
    insertRef.run(1, 2, fileId, 1)
    insertRef.run(2, 3, fileId, 1)
    insertRef.run(3, 3, fileId, 2)

    backfillSymbolInDegree(db)

    const degrees = db
      .query<{ id: number; in_degree: number }, []>('SELECT id, in_degree FROM symbols ORDER BY id')
      .all()
    expect(degrees.map((d) => d.in_degree)).toEqual([2, 1, 0])
  })

  test('backfill is idempotent and skips no-op updates', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA foreign_keys = ON')
    ensureSchema(db)
    seedFiles(db, ['src/a.ts'])
    const fileId = db.query<{ id: number }, []>('SELECT id FROM files').get()!.id

    const insertSymbol = db.query(
      `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
       VALUES (?, ?, 'src/a.ts', 'src/a', ?, ?, ?, 'function_declaration', 'exported', NULL, '[]', '', '', '', 'x', 1, 2)`,
    )
    for (const id of [1, 2, 3]) {
      insertSymbol.run(id, fileId, `src/a.ts#${id}-2`, `s${id}`, `src/a#s${id}`)
    }
    const insertRef = db.query(
      `INSERT INTO symbol_references (id, source_symbol_id, source_file_id, target_symbol_id, target_file_id, target_name, target_export_name, target_module_specifier, edge_type, confidence, line_number)
       VALUES (?, ?, ?, ?, NULL, 'x', NULL, NULL, 'calls', 'resolved', 5)`,
    )
    insertRef.run(1, 2, fileId, 1)
    insertRef.run(2, 3, fileId, 1)
    insertRef.run(3, 3, fileId, 2)

    // Pre-set in_degree to values that already equal the reference counts, so backfill has no
    // rows to change. The WHERE guard keeps those no-op rows from re-firing the symbols_au FTS
    // sync trigger; trigger-fire counts are not directly observable in bun:sqlite, so this test
    // asserts the semantic contract: an idempotent re-run yields identical values.
    db.run('UPDATE symbols SET in_degree = 2 WHERE id = 1')
    db.run('UPDATE symbols SET in_degree = 1 WHERE id = 2')

    backfillSymbolInDegree(db)

    const degrees = db
      .query<{ id: number; in_degree: number }, []>('SELECT id, in_degree FROM symbols ORDER BY id')
      .all()
    expect(degrees.map((d) => d.in_degree)).toEqual([2, 1, 0])

    backfillSymbolInDegree(db)

    const degreesAfterRerun = db
      .query<{ id: number; in_degree: number }, []>('SELECT id, in_degree FROM symbols ORDER BY id')
      .all()
    expect(degreesAfterRerun.map((d) => d.in_degree)).toEqual([2, 1, 0])
  })
})

describe('selectAllModuleExports', () => {
  test('returns export_kind alongside the other columns', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/star-index.ts', 'src/star-index', 'ts', 'x', 'indexed', NULL, datetime('now'))`,
    ).run()
    db.query(
      `INSERT INTO module_exports (id, file_id, export_name, export_kind, symbol_id, target_module_specifier) VALUES (1, 1, '*', 'star', NULL, './star-target')`,
    ).run()

    const rows = selectAllModuleExports(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      moduleKey: 'src/star-index',
      exportName: '*',
      exportKind: 'star',
      symbolId: null,
      targetModuleSpecifier: './star-target',
    })
  })
})
