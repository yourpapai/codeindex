import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { persistResolvedReferences } from '../../src/indexer/persist-resolved-references.js'
import { ensureSchema } from '../../src/storage/schema.js'

const readUserVersion = (db: Database): number =>
  db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version

const columnNames = (db: Database): string[] =>
  db
    .query<{ name: string }, []>('PRAGMA table_info(symbol_references)')
    .all()
    .map((row) => row.name)

describe('schema v6', () => {
  test('symbol_references has line_text TEXT NOT NULL and user_version is 6', () => {
    const db = new Database(':memory:')
    ensureSchema(db)

    const columns = db
      .query<{ name: string; type: string; notnull: number }, []>('PRAGMA table_info(symbol_references)')
      .all()

    const lineText = columns.find((column) => column.name === 'line_text')
    expect(lineText).toBeDefined()
    expect(lineText!.type).toBe('TEXT')
    expect(lineText!.notnull).toBe(1)
    expect(readUserVersion(db)).toBe(6)
  })

  test('opening a v5 database wipes and recreates at v6 with line_text', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/a.ts', 'src/a', 'ts', 'x', 'indexed', NULL, 0)`,
    ).run()
    db.run('PRAGMA user_version = 5')

    ensureSchema(db)

    expect(readUserVersion(db)).toBe(6)
    expect(columnNames(db)).toContain('line_text')
    const remaining = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM files').get()!.n
    expect(remaining).toBe(0)
  })

  test('persistResolvedReferences stores line_text for resolved and unresolved edges', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    db.query(
      `INSERT INTO files (id, file_path, module_key, language, file_hash, parse_status, parse_error, indexed_at) VALUES (1, 'src/a.ts', 'src/a', 'ts', 'x', 'indexed', NULL, 0)`,
    ).run()
    db.query(
      `INSERT INTO symbols (id, file_id, file_path, module_key, symbol_key, local_name, qualified_name, kind, scope_tier, parent_symbol_id, export_names, signature_text, doc_text, body_text, identifier_terms, start_line, end_line)
       VALUES (1, 1, 'src/a.ts', 'src/a', 'src/a.ts#1-1', 'helper', 'src/a#helper', 'function_declaration', 'exported', NULL, '["helper"]', '', '', '', 'helper', 1, 1)`,
    ).run()

    const { referencesIndexed, referencesUnresolved } = persistResolvedReferences(db, [
      {
        fileId: 1,
        moduleKey: 'src/a',
        referenceCandidates: {
          moduleExports: [],
          references: [
            {
              sourceQualifiedName: 'src/a#helper',
              edgeType: 'calls',
              targetName: 'helper',
              targetExportName: null,
              targetModuleSpecifier: null,
              lineNumber: 1,
              lineText: 'export function helper() { return 1 }',
            },
            {
              sourceQualifiedName: null,
              edgeType: 'imports',
              targetName: 'missing',
              targetExportName: 'missing',
              targetModuleSpecifier: './missing',
              lineNumber: 2,
              lineText: "import { missing } from './missing'",
            },
          ],
        },
      },
    ])

    expect(referencesIndexed).toBe(2)
    expect(referencesUnresolved).toBe(1)

    const rows = db
      .query<{ target_name: string; line_text: string; target_symbol_id: number | null }, []>(
        'SELECT target_name, line_text, target_symbol_id FROM symbol_references ORDER BY id',
      )
      .all()
    expect(rows).toEqual([
      {
        target_name: 'helper',
        line_text: 'export function helper() { return 1 }',
        target_symbol_id: 1,
      },
      {
        target_name: 'missing',
        line_text: "import { missing } from './missing'",
        target_symbol_id: null,
      },
    ])
  })
})
